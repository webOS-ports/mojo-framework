/*--------------------------------------------------------------------------
*  Mojo compatibility shim for modern Blink/Chromium
*
*  Loaded by mojo.js immediately after the framework blob. Everything here
*  compensates for behaviour the framework relied on in LunaSysMgr's WebKit
*  (circa 2011) that current Chromium implements differently.
*--------------------------------------------------------------------------*/
/*globals Mojo */

(function () {
	"use strict";

	/*
	 * -webkit-border-image without border-style
	 * ------------------------------------------
	 * Practically every framed surface in Mojo - grouped lists, buttons,
	 * dialogs, menus, selection highlights - is drawn with
	 *
	 *     border-width: 40px 18px 18px 18px;
	 *     -webkit-border-image: url(palm-group.png) 40 18 18 18 repeat repeat;
	 *
	 * and never sets border-style. The 2011 WebKit painted the border image
	 * regardless. CSS says border-width computes to 0 when border-style is
	 * none, so Blink resolves those widths to 0 and paints nothing at all:
	 * the chrome disappears and only bare text is left on the background.
	 *
	 * Blink still accepts the -webkit-border-image shorthand and resolves it
	 * to the standard border-image-* longhands, so the images themselves are
	 * fine. Only the missing border-style needs supplying.
	 *
	 * This is done over the CSSOM rather than by rewriting the framework
	 * stylesheets because apps ship their own CSS in exactly the same style
	 * (overriding the images while reusing the framework's classes), and
	 * those files are outside anything we package.
	 *
	 * border-color is forced transparent so that if an image ever fails to
	 * load the result is the old invisible border rather than a solid slab
	 * of the inherited text colour.
	 */
	var patchedSheets = typeof WeakSet === "function" ? new WeakSet() : null;

	/*
	 * "" when the rule says nothing about a border image, "none" when it
	 * explicitly turns one off, otherwise the image value.
	 */
	function declaredBorderImage(style) {
		return style.getPropertyValue("border-image-source") ||
			style.getPropertyValue("-webkit-border-image") || "";
	}

	function hasBorderImage(style) {
		var source = declaredBorderImage(style);
		return !!source && source !== "none" && source !== "initial";
	}

	function clearsBorderImage(style) {
		var source = declaredBorderImage(style);
		return source === "none" || source === "initial";
	}

	function patchRuleList(rules) {
		if (!rules) {
			return 0;
		}
		var patched = 0;
		for (var i = 0; i < rules.length; i++) {
			var rule = rules[i];

			// @import pulls in a whole further stylesheet, reached through
			// .styleSheet rather than .cssRules. Nearly all of Mojo's styling
			// arrives this way - global.css is little more than nine imports
			// (menus, lists, buttons, textfields, ...) - so skipping these
			// silently leaves most of the framework unpatched.
			if (rule.styleSheet) {
				patched += patchStyleSheet(rule.styleSheet);
				continue;
			}

			// @media / @supports and friends nest further rules.
			if (rule.cssRules && !rule.style) {
				patched += patchRuleList(rule.cssRules);
				continue;
			}
			if (!rule.style) {
				continue;
			}

			/*
			 * The legacy shorthand worked both ways: setting an image made
			 * the border paint, and "-webkit-border-image: none" put the
			 * border back to nothing. Apps lean on the second half - the
			 * Device Info override replaces the page header's image with a
			 * plain background:
			 *
			 *     .palm-page-header {
			 *       background: url(toolbar_light_top.png) bottom left repeat-x;
			 *       -webkit-border-image: none;
			 *     }
			 *
			 * Restoring border-style on the framework rule without honouring
			 * this leaves the header with real 35px/13px transparent borders
			 * that nothing paints, and its title is pushed out of view.
			 */
			if (clearsBorderImage(rule.style)) {
				if (!rule.style.getPropertyValue("border-style")) {
					rule.style.setProperty("border-style", "none");
				}
				if (!rule.style.getPropertyValue("border-width")) {
					rule.style.setProperty("border-width", "0");
				}
				patched++;
				continue;
			}

			if (!hasBorderImage(rule.style)) {
				continue;
			}
			// Respect an author who did specify a style; only fill the gap.
			if (rule.style.getPropertyValue("border-style")) {
				continue;
			}
			rule.style.setProperty("border-style", "solid");
			if (!rule.style.getPropertyValue("border-color")) {
				rule.style.setProperty("border-color", "transparent");
			}
			patched++;
		}
		return patched;
	}

	function patchStyleSheet(sheet) {
		if (!sheet || (patchedSheets && patchedSheets.has(sheet))) {
			return 0;
		}
		var rules;
		try {
			rules = sheet.cssRules;
		} catch (e) {
			// Opaque sheet (should not happen for file:// but be safe).
			return 0;
		}
		if (!rules) {
			return 0;			// still loading; the load event brings us back
		}
		if (patchedSheets) {
			patchedSheets.add(sheet);
		}
		return patchRuleList(rules);
	}

	function patchAllStyleSheets() {
		var total = 0;
		var sheets = document.styleSheets;
		for (var i = 0; i < sheets.length; i++) {
			total += patchStyleSheet(sheets[i]);
		}
		return total;
	}

	/*
	 * Mojo pulls scene and app stylesheets in after startup (and each stage
	 * gets its own document), so one pass at load time is not enough. Watch
	 * for new style/link nodes and patch each as it becomes readable.
	 */
	function watchForNewStyleSheets() {
		if (typeof MutationObserver !== "function") {
			return;
		}
		var observer = new MutationObserver(function (records) {
			for (var i = 0; i < records.length; i++) {
				var added = records[i].addedNodes;
				for (var j = 0; j < added.length; j++) {
					var node = added[j];
					if (!node.tagName) {
						continue;
					}
					var tag = node.tagName.toLowerCase();
					if (tag !== "link" && tag !== "style") {
						continue;
					}
					if (node.sheet) {
						patchStyleSheet(node.sheet);
					} else {
						node.addEventListener("load", function () {
							patchStyleSheet(this.sheet);
						});
					}
				}
			}
		});
		observer.observe(document.documentElement, {childList: true, subtree: true});
	}

	function run() {
		var patched = patchAllStyleSheets();
		if (window.Mojo && Mojo.Log && Mojo.Log.info) {
			Mojo.Log.info("Mojo compat: applied border-style to " + patched + " border-image rules");
		}
	}

	// External stylesheets referenced in <head> are not necessarily parsed
	// when this script runs, so patch at every point where more may have
	// arrived, and keep watching afterwards.
	run();
	watchForNewStyleSheets();
	document.addEventListener("DOMContentLoaded", run, false);
	window.addEventListener("load", run, false);

	/*
	 * PalmSystem members LunaSysMgr had and WebAppMgr does not
	 * ---------------------------------------------------------
	 * Mojo calls some of these without checking for them first, so a missing
	 * one is not a degraded feature but a TypeError that aborts whatever was
	 * in progress - scene transitions and the app menu among them.
	 *
	 * Mojo carries its own desktop-host stand-in for PalmSystem (the object
	 * with version "mojo-host"), which is Palm's own statement of what each
	 * of these should do when the compositor cannot. Those semantics are
	 * reused here, and anything WebAppMgr can genuinely back is wired up
	 * rather than stubbed.
	 *
	 * Deliberately NOT defined, because Mojo already guards them and reports
	 * their absence honestly:
	 *   encrypt / decrypt        - Mojo.Model logs "not implemented"
	 *   crossAppSceneActive      - cross-app scenes need compositor support
	 *   runCrossAppTransition    - Mojo falls back to no transition
	 */
	/* Duration and curve chosen to sit close to the card transition sysmgr
	 * used to run; long enough to read as movement, short enough that it
	 * never delays a tap. */
	var TRANSITION_MS = 220;
	var TRANSITION_EASING = "cubic-bezier(0.25, 0.1, 0.25, 1)";
	var currentAnimation = null;

	function reduceMotion() {
		return !!(window.matchMedia &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches);
	}

	/*
	 * Animate whichever scene has just become the top one. Deferred by a
	 * frame because Mojo runs the transition before the scene stack settles.
	 */
	function animateIncomingScene(fromScale) {
		if (typeof window.requestAnimationFrame !== "function") {
			return;
		}
		window.requestAnimationFrame(function () {
			var element = topSceneContainer();
			if (!element || typeof element.animate !== "function") {
				return;
			}
			if (currentAnimation) {
				// A second push landing mid-flight: drop the old one rather
				// than leaving two transforms fighting over one element.
				currentAnimation.cancel();
			}
			try {
				currentAnimation = element.animate([
					{opacity: 0, transform: "scale(" + fromScale + ")"},
					{opacity: 1, transform: "scale(1)"}
				], {
					duration: TRANSITION_MS,
					easing: TRANSITION_EASING
					// fill defaults to "none", so the element is left with
					// exactly the styles Mojo gave it once this finishes.
				});
				currentAnimation.onfinish = function () { currentAnimation = null; };
				currentAnimation.oncancel = function () { currentAnimation = null; };
			} catch (e) {
				currentAnimation = null;
			}
		});
	}

	function topSceneContainer() {
		try {
			var stage = window.Mojo && Mojo.Controller && Mojo.Controller.stageController;
			var scene = stage && stage.topScene && stage.topScene();
			var element = scene && scene.sceneElement;
			// The scene div sits inside its scroller; animating the scroller
			// moves the scene's chrome along with its content.
			return (element && element.parentNode) || element;
		} catch (e) {
			return null;
		}
	}

	/*
	 * PalmSystem.deviceInfo is missing the layout metrics
	 * ----------------------------------------------------
	 * LunaSysMgr reported maximumCardWidth, maximumCardHeight, touchableRows,
	 * keyboardAvailable and keyboardSlider alongside the model and version.
	 * WebAppMgr reports only the model, the platform version and a
	 * screenWidth/screenHeight pair that are both 0.
	 *
	 * Mojo derives touchableRows from maximumCardHeight when the host does
	 * not supply it:
	 *
	 *     touchableRows = Math.floor((maximumCardHeight - 28) / 48)
	 *
	 * With maximumCardHeight undefined that is NaN, and the menu widget
	 * writes the result straight into a class name - the app menu comes up as
	 * "palm-popup-container palm-touch-rows-NaN". That class is what carries
	 * the menu's frame:
	 *
	 *     #palm-app-menu.palm-touch-rows-7 {
	 *       -webkit-border-image: url(system-menu-background-solid.png) 30 28 35 28 ...
	 *     }
	 *
	 * so with NaN the menu loses its 30px top and 35px bottom frame while
	 * .palm-popup-content keeps its matching 31px/26px insets, and the rows
	 * spill past both ends of the popup - the top and bottom items drop off.
	 *
	 * touchableRows is pinned to 7 rather than computed: submission 506 ships
	 * styling for palm-touch-rows-7 and nothing else, so any other value
	 * leaves the menu unstyled no matter how large the display is. Seven rows
	 * (capped at 286px, then scrolling) is what the framework's own artwork is
	 * cut for.
	 */
	var TOUCHABLE_ROWS = 7;

	function installDeviceInfoShim() {
		var ps = window.PalmSystem;
		if (!ps) {
			return;
		}
		var raw = ps.deviceInfo;
		var info;
		try {
			info = JSON.parse(raw);
		} catch (e) {
			return;			// unrecognisable; leave it alone
		}

		// Resolved on read: Mojo fetches deviceInfo lazily, by which point
		// the window has its real size.
		function augmented() {
			var out = {};
			for (var key in info) {
				if (Object.prototype.hasOwnProperty.call(info, key)) {
					out[key] = info[key];
				}
			}
			if (!out.screenWidth) {
				out.screenWidth = window.screen ? window.screen.width : window.innerWidth;
			}
			if (!out.screenHeight) {
				out.screenHeight = window.screen ? window.screen.height : window.innerHeight;
			}
			// The card, not the display: this is the area an app is given.
			if (!out.maximumCardWidth) {
				out.maximumCardWidth = window.innerWidth || out.screenWidth;
			}
			if (!out.maximumCardHeight) {
				out.maximumCardHeight = window.innerHeight || out.screenHeight;
			}
			if (!out.touchableRows) {
				out.touchableRows = TOUCHABLE_ROWS;
			}
			return JSON.stringify(out);
		}

		try {
			Object.defineProperty(ps, "deviceInfo", {
				get: augmented, configurable: true, enumerable: true
			});
		} catch (e) {
			// Not redefinable; nothing further we can do here.
		}
	}

	function installPalmSystemShim() {
		var ps = window.PalmSystem;
		if (!ps) {
			return;			// desktop host; Mojo installs its own
		}

		function define(name, value) {
			if (ps[name] === undefined) {
				try {
					ps[name] = value;
				} catch (e) {
					// Some builds expose PalmSystem members as accessors on a
					// frozen prototype; fall back to an own property.
					Object.defineProperty(ps, name, {
						value: value, writable: true, configurable: true
					});
				}
			}
		}

		var noop = function () {};

		/* --- scene transitions -------------------------------------------
		 * Legacy transitions ran in the compositor: prepareSceneTransition()
		 * had sysmgr snapshot the card, and runSceneTransition() animated
		 * from that snapshot to the live content. WebAppMgr offers nothing
		 * equivalent, and Mojo calls both unguarded.
		 *
		 * We cannot snapshot, but we do not need to: both scenes are
		 * ordinary elements in one document. By the time Mojo calls
		 * runSceneTransition() the incoming scene is already display:block
		 * and the outgoing one is display:none (on a pop it is gone from the
		 * DOM entirely), so there is nothing to animate *out* - animating
		 * the incoming scene in is the whole effect that survives.
		 *
		 * The scene stack has not caught up at call time (on a push the new
		 * scene is not in getScenes() yet), so the element is picked up one
		 * frame later, when topScene() is the scene that just arrived.
		 *
		 * Mojo does not wait for us: it calls finish.defer() immediately
		 * after. That is fine - the animation is decorative and runs
		 * alongside whatever the scene's activate handler does.
		 */
		define("prepareSceneTransition", noop);

		define("runSceneTransition", function (type, isPop) {
			if (type === "none" || reduceMotion()) {
				return;
			}
			// Direction reads as depth: a pushed scene settles back from
			// slightly too close, a pop rises from slightly too far.
			var from = (type === "cross-fade") ? 1 : (isPop ? 0.94 : 1.06);
			animateIncomingScene(from);
		});

		define("cancelSceneTransition", function () {
			if (currentAnimation) {
				currentAnimation.cancel();
				currentAnimation = null;
			}
		});
		define("cancelCrossAppScene", noop);

		/* --- window properties --------------------------------------------
		 * WebAppMgr exposes the singular setWindowProperty(key, value);
		 * Mojo wants the plural bulk form.
		 */
		define("setWindowProperties", function (props) {
			if (!props || typeof ps.setWindowProperty !== "function") {
				return;
			}
			for (var key in props) {
				if (Object.prototype.hasOwnProperty.call(props, key)) {
					ps.setWindowProperty(key, String(props[key]));
				}
			}
		});

		/* --- smart-zoom animation driver -----------------------------------
		 * PalmSystem drove this loop natively. requestAnimationFrame gives
		 * the same shape: step callbacks with an eased 0..1 progress, then a
		 * completion callback.
		 */
		define("runAnimationLoop", function (target, stepMethod, completeMethod,
		                                     curve, duration, from, to) {
			var start = null;
			var ms = (duration || 0.3) * 1000;
			var easeOut = function (t) { return 1 - Math.pow(1 - t, 3); };
			var ease = (curve === "linear") ? function (t) { return t; } : easeOut;

			function frame(now) {
				if (start === null) {
					start = now;
				}
				var t = Math.min(1, (now - start) / ms);
				var value = from + (to - from) * ease(t);
				try {
					if (target && typeof target[stepMethod] === "function") {
						target[stepMethod](value);
					}
					if (t >= 1) {
						if (target && typeof target[completeMethod] === "function") {
							target[completeMethod]();
						}
						return;
					}
				} catch (e) {
					return;
				}
				window.requestAnimationFrame(frame);
			}
			window.requestAnimationFrame(frame);
		});

		/* --- text and sound ------------------------------------------------ */
		// Called unguarded when the app menu opens.
		define("hideSpellingWidget", noop);
		// Mojo.Format.runTextIndexer expects the text back unchanged.
		define("runTextIndexer", function (text) { return text; });
		define("receivePageUpDownInLandscape", noop);
		define("playSoundNotification", noop);
		define("setAlertSound", noop);

		/* --- identity ------------------------------------------------------- */
		define("version", (function () {
			try {
				return JSON.parse(ps.deviceInfo).platformVersion || "webappmgr";
			} catch (e) {
				return "webappmgr";
			}
		}()));
		// Falsy on a real device; Mojo uses it to pick the emulator input path.
		define("simulated", false);
	}


	/*
	 * Touch drags -> mouse drags
	 * --------------------------
	 * Mojo's gesture layer and Scroller are built on mousedown / mousemove /
	 * mouseup: LunaSysMgr's WebKit turned a finger into a mouse. Chromium
	 * with --touch-events only synthesises mouse events for a tap, so a
	 * drag produces touch events alone and no Mojo list or scene can be
	 * scrolled. Once a single finger has moved past a small slop, replay the
	 * gesture as the mouse sequence Mojo expects. Taps are left to Chromium
	 * untouched, so focus, links and Mojo taps behave exactly as before.
	 */
	var DRAG_SLOP = 8;

	function installTouchDragShim() {
		var start = null;		// {x, y, target} of the finger, until it drags
		var dragging = false;

		function mouse(type, target, t) {
			var ev = new MouseEvent(type, {
				bubbles: true, cancelable: true, view: window,
				clientX: t.clientX, clientY: t.clientY,
				screenX: t.screenX, screenY: t.screenY,
				button: 0, buttons: type === "mouseup" ? 0 : 1, detail: 1
			});
			(target || document).dispatchEvent(ev);
		}

		function under(t) {
			return document.elementFromPoint(t.clientX, t.clientY) || document.body;
		}

		document.addEventListener("touchstart", function (e) {
			if (e.target && e.target.closest && e.target.closest("[data-mojocompat-native-scroll]")) {
				start = null;		// our own overlays scroll natively
				dragging = false;
				return;
			}
			if (e.touches.length !== 1) {
				if (dragging) {
					mouse("mouseup", under(e.touches[0]), e.touches[0]);
				}
				start = null;
				dragging = false;
				return;
			}
			var t = e.touches[0];
			start = {x: t.clientX, y: t.clientY, sx: t.screenX, sy: t.screenY, target: e.target};
			dragging = false;
		}, true);

		document.addEventListener("touchmove", function (e) {
			if (!start || e.touches.length !== 1) {
				return;
			}
			var t = e.touches[0];
			if (!dragging) {
				if (Math.abs(t.clientX - start.x) < DRAG_SLOP &&
				    Math.abs(t.clientY - start.y) < DRAG_SLOP) {
					return;
				}
				dragging = true;
				mouse("mousedown", start.target,
				      {clientX: start.x, clientY: start.y, screenX: start.sx, screenY: start.sy});
			}
			if (e.cancelable) {
				e.preventDefault();	// Mojo scrolls itself; no native pan
			}
			mouse("mousemove", under(t), t);
		}, {capture: true, passive: false});

		function end(e) {
			if (dragging) {
				var t = e.changedTouches[0];
				mouse("mouseup", under(t), t);
			}
			start = null;
			dragging = false;
		}
		document.addEventListener("touchend", end, true);
		document.addEventListener("touchcancel", end, true);
	}

	/*
	 * document.cookie on file://
	 * --------------------------
	 * Mojo.Model.Cookie - where Mojo apps keep their preferences - is
	 * document.cookie. Chromium does not store cookies for file:// pages, so
	 * every write was dropped and apps forgot everything between launches
	 * (SimpleChat asked for a user name every time). Where a probe cookie
	 * does not stick, back document.cookie with localStorage, keyed by the
	 * application directory so apps do not see each other's.
	 */
	function installCookieShim() {
		try {
			document.cookie = "mojocompat_probe=1";
			if (document.cookie.indexOf("mojocompat_probe=1") !== -1) {
				document.cookie = "mojocompat_probe=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
				return;			// real cookies work here
			}
		} catch (e) {}

		var m = /\/applications\/([^\/]+)\//.exec(location.pathname);
		var key = "mojocompat.cookies." + (m ? m[1] : location.pathname);

		function load() {
			try {
				return JSON.parse(localStorage.getItem(key)) || {};
			} catch (e) {
				return {};
			}
		}
		function save(jar) {
			try {
				localStorage.setItem(key, JSON.stringify(jar));
			} catch (e) {}
		}

		try {
			Object.defineProperty(document, "cookie", {
				configurable: true,
				get: function () {
					var jar = load(), now = Date.now(), out = [], changed = false;
					for (var name in jar) {
						if (jar[name].exp && jar[name].exp < now) {
							delete jar[name];
							changed = true;
						} else {
							out.push(name + "=" + jar[name].v);
						}
					}
					if (changed) {
						save(jar);
					}
					return out.join("; ");
				},
				set: function (text) {
					var parts = String(text).split(";");
					var eq = parts[0].indexOf("=");
					if (eq < 1) {
						return;
					}
					var name = parts[0].slice(0, eq).trim();
					var value = parts[0].slice(eq + 1).trim();
					var exp = 0;
					for (var i = 1; i < parts.length; i++) {
						var kv = parts[i].split("=");
						var k = kv[0].trim().toLowerCase();
						if (k === "expires") {
							exp = Date.parse(kv.slice(1).join("=").trim()) || 0;
						} else if (k === "max-age") {
							exp = Date.now() + 1000 * parseInt(kv[1], 10);
						}
					}
					var jar = load();
					if (exp && exp <= Date.now()) {
						delete jar[name];
					} else {
						jar[name] = {v: value, exp: exp};
					}
					save(jar);
				}
			});
		} catch (e) {}
	}

	/*
	 * Input-method text -> the key events Mojo's TextField watches
	 * ------------------------------------------------------------
	 * Every key on LuneOS, physical or on-screen, reaches a field through
	 * the input method, so Chromium delivers text as composition / input
	 * events with keyCode 229 and no keypress. TextField hides its hint on
	 * a printable keypress and brings it back on a Delete keyup, so the
	 * "Enter a message..." hint stayed drawn over whatever was typed. After
	 * each input event, send TextField the key event it would have seen.
	 */
	function installInputKeyShim() {
		function key(type, target, code) {
			var ev = new KeyboardEvent(type, {bubbles: true, cancelable: true});
			try {
				Object.defineProperty(ev, "keyCode", {value: code});
				Object.defineProperty(ev, "charCode", {value: type === "keypress" ? code : 0});
				Object.defineProperty(ev, "which", {value: code});
			} catch (e) {
				return;
			}
			target.dispatchEvent(ev);
		}

		// Tapping inside a field did not move the caret: Mojo's gesture layer
		// cancels every mousedown, and in Chromium that mousedown is what
		// places the caret (LunaSysMgr's WebKit placed it regardless). For a
		// press on a text field, let the browser have its default.
		document.addEventListener("mousedown", function (e) {
			var t = e.target;
			if (t && (t.tagName === "TEXTAREA" ||
			          (t.tagName === "INPUT" && /^(text|search|email|url|tel|password|number|)$/i.test(t.type || "")))) {
				e.preventDefault = function () {};
			}
		}, true);

		document.addEventListener("input", function (e) {
			var t = e.target;
			if (!t || (t.tagName !== "TEXTAREA" && t.tagName !== "INPUT")) {
				return;
			}
			if (t.value === "") {
				key("keyup", t, 8);		// Mojo.Char.backspace: hint back
			} else if (/^insert/.test(e.inputType || "") && e.inputType !== "insertLineBreak") {
				var d = e.data || " ";
				key("keypress", t, d.charCodeAt(d.length - 1));
			}
		}, true);
	}

	/*
	 * Mojo.FilePicker
	 * ---------------
	 * pickFile() pushes a cross-app scene owned by com.palm.mojo-systemui (or
	 * com.palm.systemui before webOS 3). Neither exists on LuneOS, so the
	 * scene came up blank and popped straight back. Replace it with a small
	 * picker drawn in the calling stage, listing files through
	 * org.webosports.service.filemanager (the File Manager's service, which
	 * needs "filemanager-service.operation" in the app's client permissions).
	 */
	var PICKER_ROOT = "/media/internal";
	// Web apps may only read file:// under their own and the framework
	// directories; /usr/palm/frameworks/mojo/media-internal is a symlink to
	// /media/internal that makes user files loadable again, as they were on
	// webOS, so the picker can show real thumbnails.
	var PICKER_MEDIA_ALIAS = "/usr/palm/frameworks/mojo/media-internal";
	function loadableUrl(path) {
		if (path.indexOf(PICKER_ROOT + "/") === 0) {
			return "file://" + PICKER_MEDIA_ALIAS + path.slice(PICKER_ROOT.length);
		}
		return "file://" + path;
	}
	var PICKER_KINDS = {
		image: /\.(jpe?g|png|gif|bmp|webp)$/i,
		audio: /\.(mp3|m4a|aac|ogg|oga|wav|flac|amr)$/i,
		ringtone: /\.(mp3|m4a|aac|ogg|oga|wav|flac|amr)$/i,
		video: /\.(mp4|m4v|3gp|3g2|mkv|webm|mov|avi)$/i
	};

	// Plain one-shot bus call. Mojo.Service.Request adds a $activity the
	// file manager service then fails to monitor ("Denied method call
	// monitor"), so talk to the bridge directly.
	function listDirectory(path, cb) {
		var Bridge = window.PalmServiceBridge || (window.opener && window.opener.PalmServiceBridge);
		if (!Bridge) {
			cb.onFailure({errorText: "no PalmServiceBridge"});
			return;
		}
		var bridge = new Bridge();
		listDirectory.live = bridge;	// held until the reply, or it can be collected
		bridge.onservicecallback = function (text) {
			var r;
			try {
				r = JSON.parse(text);
			} catch (e) {
				r = {returnValue: false, errorText: String(text)};
			}
			if (r.returnValue) {
				cb.onSuccess(r);
			} else {
				cb.onFailure(r);
			}
			bridge.cancel && bridge.cancel();
		};
		bridge.call("luna://org.webosports.service.filemanager/GetDirectories", JSON.stringify({dir: path}));
	}

	function installFilePicker(M) {
		if (!M || !M.FilePicker) {
			return;
		}

		M.FilePicker.pickFile = function (params, stageController) {
			params = params || {};
			var kinds = params.kinds || (params.kind ? [params.kind] : []);
			var patterns = kinds.map(function (k) { return PICKER_KINDS[k]; }).filter(Boolean);
			var accept = function (name) {
				return patterns.length === 0 || patterns.some(function (re) { return re.test(name); });
			};
			var win = (stageController && stageController.window) || window;
			var doc = win.document;
			var dir = params.defaultPath || PICKER_ROOT;
			var title = params.actionName ? params.actionName : "Select a file";
			if (kinds.length === 1 && kinds[0] === "image" && !params.actionName) {
				title = "Select a photo";
			}

			var overlay = doc.createElement("div");
			overlay.setAttribute("data-mojocompat-native-scroll", "");
			overlay.style.cssText = "position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;" +
				"background:#1f1f1f;color:#eee;display:flex;flex-direction:column;" +
				"font-family:Prelude,sans-serif;font-size:18px;";
			overlay.innerHTML =
				'<div style="padding:12px 14px;background:#3a3a3a;border-bottom:1px solid #555;font-weight:bold">' +
				'<div class="mc-title"></div><div class="mc-path" style="font-size:13px;font-weight:normal;color:#aaa;margin-top:3px;word-break:break-all"></div></div>' +
				'<div class="mc-list" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch"></div>' +
				'<div style="padding:10px;background:#3a3a3a;border-top:1px solid #555">' +
				'<div class="mc-cancel" style="text-align:center;padding:12px;border-radius:8px;background:#555">Cancel</div></div>';
			overlay.querySelector(".mc-title").textContent = title;
			var list = overlay.querySelector(".mc-list");
			var pathLabel = overlay.querySelector(".mc-path");
			doc.body.appendChild(overlay);

			function close() {
				doc.removeEventListener("keydown", onBackKey, true);
				doc.removeEventListener("keyup", onBackKey, true);
				if (overlay.parentNode) {
					overlay.parentNode.removeChild(overlay);
				}
			}
			function cancel() {
				close();
				if (params.onCancel) {
					params.onCancel();
				}
			}
			// The back gesture: the compositor sends Escape to the focused
			// card (Mojo turns its keyup into Mojo.Event.back). The picker is
			// ours, not a scene, so take it here: cancel on keyup, and keep
			// both halves away from the scene underneath.
			function onBackKey(e) {
				if (e.keyCode !== 27) {
					return;
				}
				e.stopPropagation();
				e.preventDefault();
				if (e.type === "keyup") {
					cancel();
				}
			}
			doc.addEventListener("keydown", onBackKey, true);
			doc.addEventListener("keyup", onBackKey, true);
			function row(label, sub, icon, onTap) {
				var r = doc.createElement("div");
				r.style.cssText = "display:flex;align-items:center;min-height:56px;padding:4px 12px;border-bottom:1px solid #333";
				var ic = doc.createElement("div");
				ic.style.cssText = "width:48px;height:48px;flex:none;margin-right:12px;display:flex;align-items:center;justify-content:center;font-size:26px;color:#999";
				if (icon === "image") {
					// Web apps may not read file:// outside their own folder,
					// so there are no thumbnails: draw a picture instead.
					var pic = doc.createElement("div");
					pic.style.cssText = "width:36px;height:28px;border:2px solid #7aa7d6;border-radius:3px;position:relative;overflow:hidden;background:#27415c";
					var hill = doc.createElement("div");
					hill.style.cssText = "position:absolute;left:4px;bottom:-10px;width:24px;height:20px;background:#6fae5a;border-radius:50% 50% 0 0";
					var sun = doc.createElement("div");
					sun.style.cssText = "position:absolute;right:4px;top:4px;width:7px;height:7px;background:#f3d35c;border-radius:50%";
					pic.appendChild(hill);
					pic.appendChild(sun);
					ic.appendChild(pic);
				} else {
					// Drawn in CSS: this file is read without a charset, so
					// anything outside ASCII renders as mojibake.
					var shape = doc.createElement("div");
					if (icon === "folder") {
						shape.style.cssText = "width:36px;height:26px;background:#c9a227;border-radius:2px 6px 4px 4px;box-shadow:inset 0 5px 0 #e0bb3c";
					} else if (icon === "up") {
						shape.style.cssText = "width:0;height:0;border-left:14px solid transparent;border-right:14px solid transparent;border-bottom:20px solid #999";
					} else {
						shape.style.cssText = "width:26px;height:34px;background:#888;border-radius:2px";
					}
					ic.appendChild(shape);
				}
				var t = doc.createElement("div");
				t.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
				t.textContent = label;
				if (sub) {
					var st = doc.createElement("div");
					st.style.cssText = "font-size:12px;color:#999";
					st.textContent = sub;
					t.appendChild(st);
				}
				r.appendChild(ic);
				r.appendChild(t);
				r.addEventListener("click", onTap);
				list.appendChild(r);
			}
			function message(text) {
				var m = doc.createElement("div");
				m.style.cssText = "padding:24px 16px;color:#aaa;text-align:center";
				m.textContent = text;
				list.appendChild(m);
			}
			function split(v) {
				if (Array.isArray(v)) {
					return v;
				}
				return (v ? String(v).split(",") : []).filter(function (n) {
					return n && n.charAt(0) !== ".";
				}).sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
			}
			function show(path) {
				dir = path;
				pathLabel.textContent = path;
				list.innerHTML = "";
				list.scrollTop = 0;
				message("Loading...");
				listDirectory(path, {
					onSuccess: function (r) {
						list.innerHTML = "";
						if (path !== "/" && path !== PICKER_ROOT) {
							var up = path.replace(/\/[^\/]+\/?$/, "") || "/";
							row("..", "Up one folder", "up", function () { show(up); });
						}
						split(r.dirs).forEach(function (d) {
							row(d, null, "folder", function () { show(path.replace(/\/$/, "") + "/" + d); });
						});
						var files = split(r.files).filter(accept);
						var grid = null;
						files.forEach(function (f) {
							var full = path.replace(/\/$/, "") + "/" + f;
							var isImage = PICKER_KINDS.image.test(f);
							var pick = function () {
								close();
								if (params.onSelect) {
									params.onSelect({fullPath: full, iconPath: full,
										attachmentType: isImage ? "image" : "file"});
								}
							};
							if (!isImage) {
								row(f, null, "file", pick);
								return;
							}
							// Photos: a grid of real thumbnails, three across.
							if (!grid) {
								grid = doc.createElement("div");
								grid.style.cssText = "display:flex;flex-wrap:wrap;padding:3px";
								list.appendChild(grid);
							}
							var tile = doc.createElement("div");
							tile.style.cssText = "width:calc(33.333% - 6px);margin:3px;aspect-ratio:1;position:relative;background:#333;overflow:hidden;border-radius:3px";
							var img = doc.createElement("img");
							img.loading = "lazy";
							img.decoding = "async";
							img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block";
							img.src = loadableUrl(full);
							var cap = doc.createElement("div");
							cap.style.cssText = "position:absolute;left:0;right:0;bottom:0;padding:2px 4px;font-size:10px;background:rgba(0,0,0,0.55);color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
							cap.textContent = f;
							tile.appendChild(img);
							tile.appendChild(cap);
							tile.addEventListener("click", pick);
							grid.appendChild(tile);
						});
						if (!list.firstChild || (split(r.dirs).length === 0 && files.length === 0)) {
							message("No matching files here.");
						}
					},
					onFailure: function (r) {
						list.innerHTML = "";
						message("Could not list " + path + ": " + ((r && r.errorText) || "unknown error"));
					}
				});
			}

			overlay.querySelector(".mc-cancel").addEventListener("click", cancel);
			show(dir);
		};
	}

	installDeviceInfoShim();
	installPalmSystemShim();
	installTouchDragShim();
	installCookieShim();
	installInputKeyShim();

	// Exposed so a scene that injects styles by hand can re-run the pass.
	window.MojoCompat = {patchStyleSheets: patchAllStyleSheets, installFilePicker: installFilePicker};
}());
