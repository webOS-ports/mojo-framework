/*jslint evil: true */
/*--------------------------------------------------------------------------
*  Mojo JavaScript framework, version 1.0
*  Copyright 2009 Palm, Inc.  All rights reserved.
*--------------------------------------------------------------------------*/
/**
* @name mojo.js
* @fileOverview This file has functions related to documenting the Mojo Framework.
*/

// if there's an appropriately named Prototype loader global, then we're running in an environment with
// prototype built-in and should initialize it to copy it into the global object. 
if (window.InstallPrototypeBuiltIn) {
	InstallPrototypeBuiltIn(window);
} else if (window.palmInitPrototype) {
	palmInitPrototype(window,navigator,document);	
}

/**
* This section contains some methods that can be used to debug your applications and other utility functions (assert, require, loadScriptWithCallback ...)
* @namespace
* @name Mojo
*/
window.Mojo = {

	Version: {
		MAJOR: 0,
		MINOR: 1,
		POINT: 0,
		toString: function () { return [this.MAJOR, this.MINOR, this.POINT].join('.'); },
		use: 0
	},
	
	// This is a hash of version numbers to framework submissions.
	// It controls which framework build is used for each supported version.
	Versions: {
		"1": "506",
		"2": "344"
	},
	
	VersioningScheme: {
		PRE_RELEASE: "submissions",
		use: this.VERSION
	},

	findScriptTag: function() {
		if (document.querySelector) {
			return document.querySelector('script[x-mojo-version],script[x-mojo-submission]');			
		}
		var scriptTags = document.getElementsByTagName("script");
		for (var i=0; i < scriptTags.length; i++) {
			var scriptTag = scriptTags[i];
			if (scriptTag.src.match(/mojo.js/) && (scriptTag.hasAttribute('x-mojo-submission') || scriptTag.hasAttribute('x-mojo-version'))) {
				return scriptTag;
			}
		}
		return null;
	},
	
	/**
	* @private determineVersioning
	* @param {Object} url
	*/
	determineVersioning: function(url) {
		var match;
		var whichFramework;
		var scriptTag = this.findScriptTag();			
		if(scriptTag) {
			
			whichFramework = scriptTag.getAttribute('x-mojo-version');
			if(whichFramework) {
				whichFramework = Mojo.Versions[whichFramework];
			}
			else {
				whichFramework = scriptTag.getAttribute('x-mojo-submission');
			}
			
			if(whichFramework !== 'trunk') {
				Mojo.VersioningScheme.use = Mojo.VersioningScheme.PRE_RELEASE;
			}
						
			Mojo.Version.use = whichFramework;
		} else {

			match = document.baseURI.match(/framework=trunk/);
			if (match) {
				console.log("Framework trunk specified in a URL.");
				return;
			}
			match = url.match(/\?([sv]\w+)=([0-9]*)/);
			if (match) {
				// url match is ?submission=X, want to use a folder called submissions, not submission.
				if ((match[1] + "s") === Mojo.VersioningScheme.PRE_RELEASE) {
					Mojo.VersioningScheme.use = Mojo.VersioningScheme.PRE_RELEASE;
					Mojo.Version.use = match[2].valueOf();
					Mojo.Version.warnAboutSubmissionMethod = true;
				} else {
					console.log("WARNING, illegal parameters provided to mojo.js: " + match[1] + "=" + match[2]);
				}
			} else {
				match = url.match(/\?trunk/);
				if (match) {
					Mojo.Version.use = 'trunk';
					Mojo.Version.warnAboutSubmissionMethod = true;
				} else {
					throw("ERROR, illegal framework include: Please specify a framework submission. (e.g. x-mojo-submission=\"14\")");
				}
			}
		}
	},

	/**
	* @private
	*/
	generateFrameworkHome: function() {
		if (Mojo.VersioningScheme && Mojo.VersioningScheme.use) {
			return "/" + Mojo.VersioningScheme.use + "/" + Mojo.Version.use;
		} else {
			return "/trunk";
		}
	},

	/** @private */
	load: function() {
		var s, initialFileName, builtinFrameworkName, builtinFrameworkVersion;
		var script_tags = document.getElementsByTagName("script");
		for(var i = 0; i < script_tags.length; i++) {
			if (script_tags[i].src && script_tags[i].src.match(/mojo\.js(\?.*)?$/)) {
				s = script_tags[i].src;
			}
			if (s) {
				Mojo.loadString = s;
				Mojo.determineVersioning(s);
			}
		}

		builtinFrameworkVersion = Mojo.Version.use;
		builtinFrameworkName = "palmInitFramework" + builtinFrameworkVersion.replace(/\./g, "_");
		
		builtinFrameworkInit = window[builtinFrameworkName];
		if (builtinFrameworkInit) {
			console.log("=========> Calling " + builtinFrameworkName);
			builtinFrameworkInit(window,navigator,document);
		} else if (Mojo.Version.use !== 'trunk') {
			// No host-injected builtin, and released submissions ship the
			// framework only as a builtin blob (there is no javascripts/
			// source tree under submissions/NNN). Pull the blob off disk.
			Mojo.writeBuiltinScripts(builtinFrameworkName);
		} else {
			// if prototype is built-in, pull in framework directly, rather than loader that pulls in
			// prototype then framework. This is a little hacky, since it depends on knowing what's in
			// loader.js, but it will work correctly for all the old submissions.
			if (window.palmInitPrototype || window.InstallPrototypeBuiltIn) {
				initialFileName = 'framework';
			} else {
				initialFileName = 'loader';
			}
			s = '<script type="text/javascript" onerror="Mojo.reportLoadError();" src="/usr/palm/frameworks/mojo' +
			Mojo.generateFrameworkHome() +
			'/javascripts/' + initialFileName + '.js"><\/script>';
			document.write(s);
		}
	},

	/**
	* @private
	* Load the framework the way LunaSysMgr used to provide it.
	*
	* LunaSysMgr compiled Prototype and the framework into WebKit as V8
	* builtins and injected them into every app's global object before any
	* app script ran, so mojo.js only ever had to call the init function.
	* WebAppMgr has no equivalent injection hook, so fetch the same code as
	* ordinary scripts.
	*
	* These have to be parser-blocking document.write()s rather than
	* appended <script> elements: everything after the mojo.js tag - the
	* app's own markup and inline scripts - assumes the framework is fully
	* initialised, which only holds if these run before parsing resumes.
	*/
	writeBuiltinScripts: function(builtinFrameworkName) {
		var builtins = '/usr/palm/frameworks/mojo/builtins/';

		// The builtin Prototype is a natives-context rewrite that cannot be
		// parsed outside it; the stock 1.6.0.3 it was derived from exposes
		// the same API and loads as a normal script.
		if (!window.palmInitPrototype && !window.InstallPrototypeBuiltIn) {
			document.write('<script type="text/javascript" onerror="Mojo.reportLoadError();"' +
				' src="/usr/palm/frameworks/prototype/prototype-1.6.0.3.js"><\/script>');
		}

		// Modern-Blink fixups. Loaded ahead of the framework because the
		// PalmSystem members it fills in are read during initialisation;
		// its stylesheet pass is deferred and picks up Mojo's sheets as
		// they are attached.
		document.write('<script type="text/javascript"' +
			' src="/usr/palm/frameworks/mojo/mojo-compat.js"><\/script>');

		document.write('<script type="text/javascript" onerror="Mojo.reportLoadError();" src="' +
			builtins + builtinFrameworkName + '.js"><\/script>');

		// Runs once the blob above has been evaluated and has published its
		// init function onto window.
		document.write('<script type="text/javascript">Mojo.initBuiltinFramework(' +
			JSON.stringify(builtinFrameworkName) + ');<\/script>');
	},

	/**
	* @private
	* @param {String} builtinFrameworkName
	*/
	initBuiltinFramework: function(builtinFrameworkName) {
		var builtinFrameworkInit = window[builtinFrameworkName];
		if (!builtinFrameworkInit) {
			Mojo.reportLoadError();
			return;
		}
		if (typeof window.Prototype === 'undefined') {
			if (window.InstallPrototypeBuiltIn) {
				InstallPrototypeBuiltIn(window);
			} else if (window.palmInitPrototype) {
				palmInitPrototype(window, navigator, document);
			}
		}
		console.log("=========> Calling " + builtinFrameworkName);
		builtinFrameworkInit(window, navigator, document);

		var ac = Mojo.Controller && Mojo.Controller.AppController;
		if (ac && ac.prototype.finishOpenStage && !ac.prototype._lunePatched) {
			var finish = ac.prototype.finishOpenStage;
			ac.prototype.finishOpenStage = function(w) {
				try { Mojo.extendLightweightWindow(window, w); } catch (e) { console.error('extendLightweightWindow: ' + e); }
				return finish.apply(this, arguments);
			};
			ac.prototype._lunePatched = true;
		}
		if (window.MojoCompat && window.MojoCompat.installFilePicker) {
			window.MojoCompat.installFilePicker(Mojo);
		}
	},

	/**
	* @private
	* @param {Object} event
	*/
	reportLoadError: function(event) {
		var errorString = 'The load of framework submission ' + Mojo.Version.use +
		' failed. Perhaps it is not installed?';
		console.error(errorString);
		document.write(errorString);
		alert(errorString);
	}
};

/*
 * LuneOS: lightweight stages are child windows driven from the opener's
 * JavaScript context. webOS's builtin Prototype was installed into every
 * window; the stock prototype-1.6.0.3.js loaded here only extends the
 * opener's own DOM prototypes, so a child's body has no addClassName and
 * StageController aborts ("body element must be extended by prototype"),
 * leaving a black card. Copy Prototype's additions across before the
 * framework sets the child up. Only names the child lacks are defined.
 */
Mojo.extendLightweightWindow = function(from, to) {
	var names = Object.getOwnPropertyNames(from);
	for (var i = 0; i < names.length; i++) {
		var n = names[i];
		if (!/^(HTML\w*Element|Element|Node|Event|Document|HTMLDocument)$/.test(n)) {
			continue;
		}
		var src = from[n] && from[n].prototype, dst = to[n] && to[n].prototype;
		if (!src || !dst || src === dst) {
			continue;
		}
		var props = Object.getOwnPropertyNames(src);
		for (var j = 0; j < props.length; j++) {
			var d = Object.getOwnPropertyDescriptor(src, props[j]);
			if (d && typeof d.value === 'function' && !(props[j] in dst)) {
				Object.defineProperty(dst, props[j], d);
			}
		}
	}
	/* mojo-compat.js fills in PalmSystem members Mojo calls unguarded. A
	 * child loads its own copy (below); this covers a stage finished
	 * before that script has run. */
	var fps = from.PalmSystem, tps = to.PalmSystem;
	if (fps && tps && fps !== tps) {
		for (var k in fps) {
			if (tps[k] === undefined && typeof fps[k] === 'function') {
				try { tps[k] = fps[k]; } catch (e) {}
			}
		}
	}
	/* Prototype also extends document itself (observe, fire, ...). */
	['observe', 'stopObserving', 'fire'].forEach(function(m) {
		if (from.document[m] && !to.document[m]) {
			to.document[m] = from.document[m];
		}
	});
};

Mojo.isLightweight = document.baseURI.match(/lightweight=true/);
if (Mojo.isLightweight) {
	var otherMojo = window.opener.Mojo;
	var f = function finishLoading(loadEvent) {
		window.removeEventListener('load', arguments.callee, false);
		try { otherMojo.extendLightweightWindow(window.opener, window); } catch (e) { console.error('extendLightweightWindow: ' + e); }
		otherMojo.Controller.appController.finishOpenStage(loadEvent.target.defaultView);
	};
	window.addEventListener('load', f, false);
	document.write('<script type="text/javascript"' +
		' src="/usr/palm/frameworks/mojo/mojo-compat.js"><\/script>');
	otherMojo.loadStylesheets(document, false);
	otherMojo.loadStylesheets(document, true);
} else {
	Mojo.load();
}

if((Mojo.Version.use === 'trunk' || parseInt(Mojo.Version.use,10) >= 135 )) {
	if(window.PalmSystem && window.PalmSystem.stagePreparing) {
		window.PalmSystem.stagePreparing();
	}
}
