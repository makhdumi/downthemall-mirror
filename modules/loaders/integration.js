/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

/* **
 * Lazy getters
 */
/* global DTA, Mediator, Version, Preferences, recognizeTextLinks, TextLinks */
/* global ContentHandling, CoThreads, getIcon, bundle, isWindowPrivate */
lazy(this, 'DTA', function() require("api"));
lazy(this, "Mediator", function() require("support/mediator"));
lazy(this, 'Version', function() require("version"));
lazy(this, 'Preferences', function() require("preferences"));
this.__defineGetter__('recognizeTextLinks', function() Preferences.getExt("textlinks", true));
lazy(this, "ContentHandling", function() require("support/contenthandling").ContentHandling);
lazy(this, 'CoThreads', function() require("support/cothreads"));
lazy(this, 'getIcon', function() require("support/icons").getIcon);
lazy(this, "bundle", function() new (require("utils").StringBundles)(["chrome://dta/locale/menu.properties"]));
lazy(this, "isWindowPrivate", function() require("support/pbm").isWindowPrivate);
lazy(this, "identity", () => require("support/memoize").identity);

const {filterInSitu, mapFilterInSitu} = require("utils");

const {unloadWindow} = require("support/overlays");
const strfn = require("support/stringfuncs");

const {Task} = requireJSM("resource://gre/modules/Task.jsm");

var findLinksJob = 0;

const MENU_ITEMS = [
	'SepBack', 'Pref', 'SepPref', 'TDTA', 'DTA', 'TDTASel',
	'DTASel', 'SaveLinkT', 'SaveLink', 'SaveImgT', 'SaveImg',
	'SaveVideoT', 'SaveVideo', 'SaveAudioT', 'SaveAudio',
	'SaveFormT', 'SaveForm', 'SepFront'
	];

/* **
 * Helpers and tools
 */
function trimMore(t) {
	return identity(t.replace(/^[\s_]+|[\s_]+$/gi, '').replace(/(_){2,}/g, "_"));
}

function extractDescription(child) {
	let rv = [];
	try {
		let fmt = function(s) {
			try {
				return trimMore(s.replace(/(\n){1,}/gi, " ").replace(/(\s){2,}/gi, " "));
			}
			catch (ex) { /* no-op */ }
			return "";
		};
		for (let i = 0, e = child.childNodes.length; i < e; ++i) {
			let c = child.childNodes[i];

			if (c.nodeValue && c.nodeValue) {
				rv.push(fmt(c.nodeValue));
			}

			if (c.nodeType == 1) {
				rv.push(extractDescription(c));
			}

			if (c && 'hasAttribute' in c) {
				if (c.hasAttribute('title')) {
					rv.push(fmt(c.getAttribute('title')));
				}
				else if (c.hasAttribute('alt')) {
					rv.push(fmt(c.getAttribute('alt')));
				}
			}
		}
	}
	catch(ex) {
		log(LOG_ERROR, 'extractDescription', ex);
	}
	return trimMore(rv.join(" "));
}

const getSniffedInfo_name = /^(?:[a-f0-9]+|\d+|(?:video)playback|player)$/i;
function getSniffedInfoFromLocation(l) {
	if (!Preferences.getExt('listsniffedvideos', false)) {
		return [];
	}
	const docURI = Services.io.newURI(l.url.spec, l.url.originCharset, null);
	return ContentHandling.getSniffedVideosFor(docURI, l.isPrivate).map(function(e) {
		let [fn,ext] = strfn.getFileNameAndExt(e.spec);
		if (!ext || getSniffedInfo_name.test(fn)) {
			ext = ext || "flv";
			fn = strfn.replaceSlashes(strfn.getUsableFileName(l.title) || "unknown", "-");
		}
		return {
			url: e,
			name: fn + "." + ext,
			ref: docURI
		};
	});
}

/* **
 * LOADER
 */
exports.load = function load(window, outerEvent) {
	let document = window.document;
	let setTimeoutOnlyFun = function(c) {
		if (typeof(c) != "function") {
			throw new Error("do not call me with a string!");
		}
		return window.setTimeout.apply(window, arguments);
	};
	let setIntervalOnlyFun = function(c) {
		if (typeof(c) != "function") {
			throw new Error("do not call me with a string!");
		}
		return window.setInterval.apply(window, arguments);
	};
	let clearInterval = window.clearInterval;
	let gBrowser = window.gBrowser;

	function $() {
		if (arguments.length == 1) {
			return document.getElementById(arguments[0]);
		}
		let elements = [];
		for (let i = 0, e = arguments.length; i < e; ++i) {
			let id = arguments[i];
			let element = document.getElementById(id);
			if (element) {
				elements.push(element);
			}
			else {
				log(LOG_ERROR, "requested a non-existing element: " + id);
			}
		}
		return elements;
	}

	let _selector = null;

	let _notify = function (title, message, priority, mustAlert, timeout) {
		switch (Preferences.getExt("notification2", 1)) {
		case 1:
			if ('PopupNotifications' in window) {
				try {
					timeout = timeout || 2500;
					let notification = window.PopupNotifications.show(
							gBrowser.selectedBrowser,
							'downthemall',
							message,
							'downthemall-notification-icon',
							null,
							null,
							{timeout: timeout}
							);
					setTimeoutOnlyFun(function() {
						window.PopupNotifications.remove(notification);
					}, timeout);
					return;
				}
				catch (ex) {
					// no op
				}
				return;
			}
			// fall through in case we got not doorhangers
		case 2:
			require("support/alertservice")
				.show("DownThemAll!", message, null, "chrome://dtaicon/content/icon64.png");
			return;
		default:
			// no notification
			return;
		}
	};

	function notifyError(title, message) _notify(title, message, 'PRIORITY_CRITICAL_HIGH', true, 1500);
	function notifyInfo(message) {
		if (!_selector) {
			_notify('', message, 'PRIORITY_INFO_MEDIUM', false);
		}
	}

	function selectButton() {
		return $('dta-turboselect-button') || {checked: false};
	}
	function getMethod(method) {
		let b = gBrowser.selectedBrowser;
		return new Promise((resolve, reject) => {
			let job = ++findLinksJob;
			let result = m => {
				b.messageManager.removeMessageListener(`DTA:${method}:${job}`, result);
				resolve(m.data);
			}
			b.messageManager.addMessageListener(`DTA:${method}:${job}`, result);
			b.messageManager.sendAsyncMessage(`DTA:${method}`, {job:job});
		});
	}
	function getCurrentLocations() {
		return getMethod("getLocations");
	}
	function getFocusedDetails() {
		return getMethod("getFocusedDetails");
	}
	function findBrowsers(all) {
		let browsers = [];
		if (!all) {
			browsers.push(gBrowser.selectedBrowser);
			return browsers;
		}
		for (let e of gBrowser.browsers) {
			browsers.push(e);
		}
		return browsers;
	}

	const unique = i => {
		return filterInSitu(i, function(e) {
			let u = e.url.spec;
			let other = this[u];
			if (other) {
				if (!other.description) {
					other.description = e.description;
				}
				if (!other.fileName) {
					other.fileName = e.fileName;
				}
				return false;
			}
			this[u] = e;
			return true;
		}, Object.create(null));
	};

	function findLinks(turbo, all) {
		try {
			if (!all && turbo && Preferences.getExt('rememberoneclick', false)) {
				all = Preferences.getExt('lastalltabs', false);
			}
			if (turbo && all) {
				Preferences.setExt('lastalltabs', all);
			}

			if (turbo) {
				log(LOG_INFO, "findLinks(): DtaOneClick request from the user");
			}
			else {
				log(LOG_INFO, "findLinks(): DtaStandard request from the user");
			}

			let collectedUrls = [];
			let collectedImages = [];
			let urlsLength = 0;
			let imagesLength = 0;

			// long running fetching may confuse users, hence give them a hint that
			// stuff is happening
			let intervalfunc;
			let _updateInterval = setIntervalOnlyFun(intervalfunc = (function(isStarter) {
				if (isStarter) {
					clearInterval(_updateInterval);
					_updateInterval = setIntervalOnlyFun(intervalfunc, 150, false);
				}
				if (urlsLength + imagesLength) {
					notifyProgress(bundle.getFormattedString('processing.label', [urlsLength, imagesLength]));
				}
				else {
					notifyProgress(bundle.getString('preparing.label'));
				}
			}), 1750, true);

			new Task.spawn(function*() {
				try {
					let promises = [];
					let job = findLinksJob++;
					for (let b of findBrowsers(all)) {
						let browser = b;
						promises.push(new Promise((resolve, reject) => {
							let progress = m => {
								urlsLength += m.data.urls;
								imagesLength += m.data.images;
							};
							let result = m => {
								browser.messageManager.removeMessageListener("DTA:findLinks:progress:" + job, progress);
								browser.messageManager.removeMessageListener("DTA:findLinks:" + job, result);
								resolve(m.data);
							};
							log(LOG_ERROR, browser);
							browser.messageManager.addMessageListener("DTA:findLinks:progress:" + job, progress);
							browser.messageManager.addMessageListener("DTA:findLinks:" + job, result);
							browser.messageManager.sendAsyncMessage("DTA:findLinks", {
								job: job,
								honorSelection: !all,
								recognizeTextLinks: recognizeTextLinks
							});
						}));
					}

					let nonnull = function(e) {
						return !!e;
					};
					let makeURI = function(u) {
						return new DTA.URL(Services.io.newURI(u.spec, u.originCharset, null));
					};
					let transposeURIs = function(e) {
						try {
							e.url = makeURI(e.url);
							e.ref = e.ref && makeURI(e.ref);
							return e;
						}
						catch (ex) {
							return null;
						}
					};
					for (let p of promises) {
						let {urls, images, locations} = yield p;
						if (!urls.length && !images.length && !locations.length) {
							continue;
						}
						collectedUrls = collectedUrls.concat(mapFilterInSitu(urls, transposeURIs, nonnull));
						collectedImages = collectedImages.concat(mapFilterInSitu(images, transposeURIs, nonnull));
						for (let l of locations) {
							let sniffed = getSniffedInfoFromLocation(l);
							for (let s of sniffed) {
								let o = {
									"url": new DTA.URL(s.url),
									"fileName": s.name,
									"referrer": s.ref,
									"description": bundle.getString('sniffedvideo')
								};
								collectedUrls.push(o);
								collectedImages.push(o);
							}
						}
					}
					unique(collectedUrls);
					for (let e of collectedUrls) {
						if (!e.description) {
							e.description = e.defaultDescription || "";
						}
						delete e.defaultDescription;
						e.description = identity(e.description);
					}

					unique(collectedImages);
					for (let e of collectedImages) {
						if (!e.description) {
							e.description = e.defaultDescription || "";
						}
						delete e.defaultDescription;
						e.description = identity(e.description);
					}

					// clean up the "hint" notification from above
					clearInterval(_updateInterval);
					notifyProgress();

					log(LOG_DEBUG, "findLinks(): finishing...");
					if (!collectedUrls.length && !collectedImages.length) {
						notifyError(bundle.getString('error'), bundle.getString('error.nolinks'));
						return;
					}

					DTA.setPrivateMode(window, collectedUrls);
					DTA.setPrivateMode(window, collectedImages);

					if (turbo) {
						DTA.turboSaveLinkArray(window, collectedUrls, collectedImages, function(queued) {
							if (!queued) {
								DTA.saveLinkArray(window, collectedUrls, collectedImages, bundle.getString('error.information'));
							}
							if (typeof queued == 'number') {
								notifyInfo(bundle.getFormattedString('queuedn', [queued]));
							}
							else {
								notifyInfo(bundle.getFormattedString('queued', [queued.url]));
							}
						});
						return;
					}
					DTA.saveLinkArray(window, collectedUrls, collectedImages);
				}
				catch (ex) {
					log(LOG_ERROR, "findLinksTask", ex);
				}
			}.bind(this));
		}
		catch(ex) {
			log(LOG_ERROR, 'findLinks', ex);
		}
	}

	function findSingleLink(turbo) {
		try {
			if (!window.gContextMenu.onSaveableLink) {
				return;
			}
			let cur = window.gContextMenu.target;
			while (!("tagName" in cur) || !cur.tagName.match(/^a$/i)) {
				cur = cur.parentNode;
			}
			saveSingleLink(turbo, cur.href, cur);
			return;
		}
		catch (ex) {
			notifyError(bundle.getString('error'), bundle.getString('errorcannotdownload'));
			log(LOG_ERROR, 'findSingleLink: ', ex);
		}
	}

	function findSingleImg(turbo) {
		try {
			let cur = window.gContextMenu.target;
			while (!("tagName" in cur) || !cur.tagName.match(/^img$/i)) {
				cur = cur.parentNode;
			}
			saveSingleLink(turbo, cur.src, cur);
		}
		catch (ex) {
			notifyError(bundle.getString('error'), bundle.getString('errorcannotdownload'));
			log(LOG_ERROR, 'findSingleLink: ', ex);
		}
	}

	function _findSingleMedia(turbo, tag) {
		function isMedia(n) 'tagName' in n && n.tagName.toLowerCase() == tag;

		let ctx = window.gContextMenu;
		try {
			let cur = ctx.target;
			while (cur && !isMedia(cur)) {
				let cn = cur.getElementsByTagName(tag);
				if (cn.length) {
					cur = cn[0];
					break;
				}
				cur = cur.parentNode;
			}

			if (!cur.src) {
				cur = cur.getElementsByTagName('source')[0];
			}
			saveSingleLink(turbo, cur.src, cur);
			return;
		}
		catch (ex) {
			try {
				if (ctx.mediaURL) {
					saveSingleLink(turbo, ctx.mediaURL, ctx.target);
				}
			}
			catch (ex) {
				notifyError(bundle.getString('error'), bundle.getString('errorcannotdownload'));
				log(LOG_ERROR, '_findSingleMedia: ', ex);
			}
		}
	}
	function findSingleVideo(turbo) {
		_findSingleMedia(turbo, 'video');
	}
	function findSingleAudio(turbo) {
		_findSingleMedia(turbo, 'audio');
	}

	function findSniff(event, turbo) {
		const target = event.explicitOriginalTarget;
		if (target.classList.contains("dta-sniff-element") && target.info) {
			DTA.saveSingleItem(window, turbo, target.info);
		}
	}

	function saveSingleLink(turbo, url, elem) {
		const owner = elem.ownerDocument;
		let defaultDescription = trimMore(owner.title || "");

		url = Services.io.newURI(url, owner.characterSet, null);
		let ml = DTA.getLinkPrintMetalink(url);
		url = new DTA.URL(ml ? ml : url);

		const item = {
			"url": url,
			"description": extractDescription(elem) || defaultDescription,
			"referrer": DTA.getRef(owner),
			"isPrivate": isWindowPrivate(window)
		};
		log(LOG_DEBUG, "saveSingleLink; processing " + elem.localName);
		if (!ml && elem.localName == "a") {
			let fn = elem.getAttribute("download");
			log(LOG_DEBUG, "saveSingleLink; fn " + fn);
			if (fn && (fn = fn.trim())) {
				item.fileName = fn;
			}
		}

		if (turbo) {
			try {
				DTA.saveSingleItem(window, true, item);
				notifyInfo(bundle.getFormattedString('queued', [url]));
				return;
			}
			catch (ex) {
				log(LOG_ERROR, 'saveSingleLink', ex);
				notifyError(bundle.getString('error'), bundle.getString('error.information'));
			}
		}
		DTA.saveSingleItem(window, false, item);
	}

	function findForm(turbo) {
		Task.spawn(function*() {
			try {
				let ctx = window.gContextMenu;
				if (!('form' in ctx.target)) {
					throw new Components.Exception("No form");
				}
				let form = ctx.target.form;

				let action = DTA.URL(DTA.composeURL(form.ownerDocument, form.action));

				let charset = form.ownerDocument.characterSet;
				if (form.acceptCharset) {
					charset = form.acceptCharset;
				}
				if (charset.match(/utf-?(?:16|32)/i)) {
					charset = 'utf-8';
				}

				let values = [];

				for (let i = 0; i < form.elements.length; ++i) {
					if (!form.elements[i].name) {
						continue;
					}
					let v = Services.ttsu.ConvertAndEscape(charset, form.elements[i].name) + "=";
					if (form.elements[i].value) {
						v += Services.ttsu.ConvertAndEscape(charset, form.elements[i].value);
					}
					values.push(v);
				}
				values = values.join("&");

				if (form.method.toLowerCase() == 'post') {
					let ss = new Instances.StringInputStream(values, -1);
					let ms = new Instances.MimeInputStream();
					ms.addContentLength = true;
					ms.addHeader('Content-Type', 'application/x-www-form-urlencoded');
					ms.setData(ss);

					let sis = new Instances.ScriptableInputStream();
					sis.init(ms);
					let postData = '';
					let avail = 0;
					while ((avail = sis.available())) {
						postData += sis.read(avail);
					}
					sis.close();
					ms.close();
					ss.close();

					action.postData = postData;
				}
				else {
					action.url.query = values;
					action.url.ref = '';
				}

				let {ref, title} = yield getFocusedDetails();
				ref = ref && Services.io.newURI(ref.spec, ref.originCharset, null);
				let defaultDescription = trimMore(title || "");
				let desc = extractDescription(form) || defaultDescription;

				let item = {
					"url": action,
					"referrer": ref,
					"description": desc,
					"isPrivate": isWindowPrivate(window)
				};

				if (turbo) {
					try {
						DTA.saveSingleItem(window, true, item);
						return;
					}
					catch (ex) {
						log(LOG_ERROR, 'findSingleLink', ex);
						notifyError(bundle.getString('error'), bundle.getString('error.information'));
					}
				}
				DTA.saveSingleItem(window, false, item);
			}
			catch (ex) {
				log(LOG_ERROR, 'findForm', ex);
			}
		});
	}

	let notifyProgress = function(message) {
		try {
			let _n = null;
			if ('PopupNotifications' in window) {
				return (notifyProgress = function(message) {
					if (!Preferences.getExt("notification2", 1) !== 1) {
						return;
					}
					if (!message && _n) {
						window.PopupNotifications.remove(_n);
						_n = null;
						return;
					}
					if (!message) {
						return;
					}
					_n = window.PopupNotifications.show(
						gBrowser.selectedBrowser,
						'downthemall',
						message,
						'downthemall-notification-icon'
						);
				})(message);
			}
			return (notifyProgress = function() {})();
		}
		catch (ex) {
			log(LOG_ERROR, "np", ex);
			notifyProgress = function() {};
		}
	};

	let frameToLog = m => log(m.data.level, m.data.message, m.data.exception);
	window.messageManager.addMessageListener("DTA:log", frameToLog);
	let fs = "chrome://dta-modules/content/loaders/integration-content.js?" + (+new Date());
	window.messageManager.loadFrameScript(fs, true);
	unloadWindow(window, () => {
		window.messageManager.broadcastAsyncMessage("DTA:shutdown");
		window.messageManager.removeMessageListener("DTA:log", frameToLog);
		window.messageManager.removeDelayedFrameScript(fs);
	});

	// these are only valid after the load event.
	let direct = {};
	let compact = {};
	let tools = {};

	let ctxBase = $('dtaCtxCompact');
	let toolsBase = $('dtaToolsMenu');
	let toolsMenu = $('dtaToolsPopup');
	let toolsSep = $('dtaToolsSep');

	let ctx = ctxBase.parentNode;
	let menu = toolsBase.parentNode;

	function onContextShowing(evt) {
		try {
			let ctx = window.gContextMenu;
			// get settings
			let items = Preferences.getExt("ctxmenu", "1,1,0").split(",").map(function(e) parseInt(e, 10));
			let showCompact = Preferences.getExt("ctxcompact", false);

			let menu;
			if (showCompact) {
				ctxBase.hidden = false;
				menu = compact;
			}
			else {
				ctxBase.hidden = true;
				menu = direct;
			}

			// hide all
			for (let i in menu) {
				direct[i].hidden = true;
				compact[i].hidden = true;
			}
			// show nothing!
			if (items.indexOf(1) == -1) {
				ctxBase.hidden = true;
				return;
			}

			// setup menu items
			// show will hold those that will be shown
			let show = [];

			let sel = ctx && ctx.isContentSelected;
			if (sel) {
				if (items[0]) {
					show.push(menu.DTASel);
				}
				if (items[1]) {
					show.push(menu.TDTASel);
				}
			}

			// hovering an image or link
			if (ctx && (ctx.onLink || ctx.onImage || ctx.onVideo || ctx.onAudio)) {
				if (items[0]) {
					if (ctx.onLink) {
						show.push(menu.SaveLink);
					}
					if (ctx.onImage) {
						show.push(menu.SaveImg);
					}
					if (ctx.onVideo) {
						show.push(menu.SaveVideo);
					}
					if (ctx.onAudio) {
						show.push(menu.SaveAudio);
					}
				}
				if (items[1]) {
					if (ctx.onLink) {
						show.push(menu.SaveLinkT);
					}
					if (ctx.onImage) {
						show.push(menu.SaveImgT);
					}
					if (ctx.onVideo) {
						show.push(menu.SaveVideoT);
					}
					if (ctx.onAudio) {
						show.push(menu.SaveAudioT);
					}
				}
			}
			else if (ctx.target && ('form' in ctx.target)) {
				if (items[0]) {
					show.push(menu.SaveForm);
				}
				if (items[1]) {
					show.push(menu.SaveFormT);
				}
			}
			// regular
			else if (!sel) {
				if (items[0]) {
					show.push(menu.DTA);
				}
				if (items[1]) {
					show.push(menu.TDTA);
				}
			}

			// prefs
			if (items[2]) {
				show.push(menu.Pref);
				if (compact && (items[0] || items[1])) {
					show.push(menu.SepPref);
				}
			}

			// show the seperators, if required.
			let n = menu.SepFront;
			while ((n = n.previousSibling)) {
				if (n.hidden) {
					continue;
				}
				if (n.nodeName != 'menuseparator') {
					show.push(menu.SepFront);
				}
				break;
			}
			n = menu.SepBack;
			while ((n = n.nextSibling)) {
				if (n.hidden) {
					continue;
				}
				if (n.nodeName != 'menuseparator') {
					show.push(menu.SepBack);
				}
				break;
			}
			for (let node of show) {
				node.hidden = false;
			}
		}
		catch(ex) {
			log(LOG_ERROR, "DTAContext(): ", ex);
		}
	}

	function onToolsShowing(evt) {
		try {

			// get settings
			let menu = Preferences.getExt("toolsmenu", "1,1,1").split(",").map(function(e) parseInt(e, 10));

			// all hidden...
			let hidden = Preferences.getExt("toolshidden", false);
			for (let i in tools) {
				tools[i].hidden = hidden;
			}
			toolsBase.hidden = hidden;
			if (hidden) {
				return;
			}

			let compact = menu.indexOf(0) != -1;

			// setup menu items
			// show will hold those that will be shown
			let show = [];

			if (menu[0]) {
				show.push('DTA');
			}
			if (menu[1]) {
				show.push('TDTA');
			}
			// prefs
			if (menu[2]) {
				show.push('Manager');
			}
			toolsSep.hidden = menu.indexOf(0) == -1;
			toolsBase.setAttribute('label',
				bundle.getString(menu.indexOf(1) != -1 ? 'moredtatools' : 'simpledtatools'));

			// show the items.
			for (let i in tools) {
				let cur = tools[i];
				if (show.indexOf(i) == -1) {
					toolsMenu.insertBefore(cur, toolsSep);
				}
				else {
					toolsBase.parentNode.insertBefore(cur, toolsBase);
				}
			}
		}
		catch(ex) {
			log(LOG_ERROR, "DTATools(): ", ex);
		}
	}

	function onDTAShowing(evt) {
		let menu = evt.target;
		for (let n of menu.querySelectorAll(".dta-sniff-element")) {
			n.parentNode.removeChild(n);
		}
		if (!Preferences.getExt('listsniffedvideos', false)) {
			return;
		}
		Task.spawn(function*() {
			const locations = yield getCurrentLocations();
			let sniffed = [];
			for (let l of locations) {
				sniffed = sniffed.concat(getSniffedInfoFromLocation(l));
			}
			if (!sniffed.length) {
				return;
			}

			let sep = document.createElement("menuseparator");
			sep.className = "dta-sniff-element";
			menu.appendChild(sep);

			let cmd = menu.parentNode.getAttribute("buttoncommand") + "-sniff";
			for (let s of sniffed) {
				let o = {
					"url": new DTA.URL(s.url),
					"referrer": s.ref,
					"fileName": s.name,
					"description": bundle.getString("sniffedvideo"),
					"isPrivate": isWindowPrivate(window)
				};
				let mi = document.createElement("menuitem");
				mi.setAttribute("label", strfn.cropCenter(s.name, 60));
				mi.setAttribute("tooltiptext", o.url.spec);
				mi.setAttribute("image", getIcon(s.name));
				mi.setAttribute("command", cmd);
				mi.info = o;
				mi.className = "dta-sniff-element menuitem-iconic";
				menu.appendChild(mi);
			}
		});
	}

	function onDTAViewShowing(button, view) {
		for (let n of view.querySelectorAll(".dta-sniff-element")) {
			n.parentNode.removeChild(n);
		}
		if (!Preferences.getExt('listsniffedvideos', false)) {
			return;
		}
		Task.spawn(function*() {
			const locations = yield getCurrentLocations();
			let sniffed = [];
			for (let l of locations) {
				sniffed = sniffed.concat(getSniffedInfoFromLocation(l));
			}
			if (!sniffed.length) {
				return;
			}

			let menu = view.querySelector(".panel-subview-body");

			let sep = document.createElement("menuseparator");
			sep.className = "dta-sniff-element";
			menu.appendChild(sep);

			let cmd = button.getAttribute("buttoncommand") + "-sniff";
			for (let s of sniffed) {
				let o = {
					"url": new DTA.URL(s.url),
					"referrer": s.ref,
					"fileName": s.name,
					"description": bundle.getString("sniffedvideo"),
					"isPrivate": isWindowPrivate(window)
				};
				let mi = document.createElement("toolbarbutton");
				mi.setAttribute("label", strfn.cropCenter(s.name, 60));
				mi.setAttribute("tooltiptext", o.url.spec);
				mi.setAttribute("image", getIcon(s.name));
				mi.setAttribute("command", cmd);
				mi.info = o;
				mi.className = "dta-sniff-element subviewbutton cui-withicon";
				menu.appendChild(mi);
			}
		});
	}

	function attachOneClick() {
		if (!!_selector) {
			return;
		}
		_selector = new Selector();
	}
	function detachOneClick() {
		if (!_selector) {
			return;
		}
		_selector.dispose();
		_selector = null;
	}

	let _keyActive =  false;
	function onKeyDown(evt) {
		return; // XXX reenable when polished
		/*if (_keyActive) {
			return;
		}
		if (evt.shiftKey && evt.ctrlKey) {
			_keyActive = true;
			selectButton().checked = true;
			attachOneClick();
		}*/
	}
	function onKeyUp(evt) {
		return; // XXX reenable when polished
		/*if (!_keyActive) {
			return;
		}
		if (evt.shiftKey) {
			_keyActive = false;
			selectButton().checked = false;
			detachOneClick();
		}*/
	}
	function onToolbarInstall(event) {
		// white list good locations
		// note that this is only performed to keep the number of event listeners down
		// The remote site does not get special privileges!
		try {
			if (!/^about:downthemall/.test(event.target.location) &&
				event.target.location.host != "about.downthemall.net") {
				return;
			}
		}
		catch (ex) {
			// might be another location where there is no .host
			return;
		}
		let tbinstall, tbunload, win = event.target;
		win.addEventListener("DTA:toolbarinstall", tbinstall = (function() {
			win.removeEventListener("DTA:toolbarinstall", tbinstall, true);
			win.removeEventListener("unload", tbunload, true);
			Mediator.showToolbarInstall(window);
		}), true);
		win.addEventListener("unload", tbunload = (function() {
			win.removeEventListener("DTA:toolbarinstall", tbinstall, true);
			win.removeEventListener("unload", tbunload, true);
		}), true);
	}

	function onBlur(evt) {
		return; // XXX reenable when polished
		/*// when the window loses focus the keyup might not be received.
		// better toggle back
		if (!_keyActive) {
			return;
		}
		_keyActive = false;
		selectButton().checked = false;
		detachOneClick();
		*/
	}

	function toggleOneClick() {
		if (selectButton().checked) {
			attachOneClick();
		}
		else {
			detachOneClick();
		}
	}

	function Selector() {
		let tp = this;
		this._callback = function(evt) tp.onClickOneClick(evt);

		window.addEventListener('click', this._callback, true);
		window.addEventListener('mouseup', this._callback, false);
		window.addEventListener('mousemove', this._callback, false);

		this._detachObserver = Preferences.addObserver('extensions.dta.selectbgimages', this);
		this.observe();
	}
	Selector.prototype = {
		dispose: function() {
			window.removeEventListener('click', this._callback, true);
			window.removeEventListener('mouseup', this._callback, false);
			window.removeEventListener('mousemove', this._callback, false);
			this.detachHilight();
			this._detachObserver();
		},
		detachHilight: function () {
			if (this._hilight) {
				this._hilight.hide();
				delete this._hilight;
			}
		},
		getBgImage: function(e) {
			if (!e || !e.ownerDocument) {
				return null;
			}
			let url = e.ownerDocument.defaultView.getComputedStyle(e, "").getPropertyCSSValue('background-image');
			if (url && url.primitiveType == window.CSSPrimitiveValue.CSS_URI) {
				return {elem: e, url: url.getStringValue()};
			}
			return getBgImage(e.parentNode);
		},
		findElemUnderCursor: function (e, n, a) {
			if (n == 'bgimg') {
				return this.getBgImage(e);
			}
			if (!e || !e.localName) {
				return null;
			}
			if (e.localName.toLowerCase() == n && e[a]) {
				return {elem: e, url: e[a] };
			}
			return this.findElemUnderCursor(e.parentNode, n, a);
		},
		cancelEvent: function (evt) {
			if (!evt.cancelable) {
				return;
			}
			evt.preventDefault();
			evt.stopPropagation();
		},
		onClickOneClick: function(evt) {

			let target = evt.target;
			let doc = target.ownerDocument;

			function processRegular(e) {
				let m = this.findElemUnderCursor(target, e[0], e[1]);
				if (!m) {
					return false;
				}
				try {
					saveSingleLink(true, m.url, m.elem);
					this.detachHilight();
					new this.Flasher(m.elem).hide();
				}
				catch (ex) {
					log(LOG_ERROR, "processRegular", ex);
					return false;
				}
				return true;
			}
			function highlightElement(e) {
				let m = this.findElemUnderCursor(target, e[0], e[1]);
				if (!m) {
					return false;
				}
				if (this._hilight && this._hilight.elem == m.elem) {
					return true;
				}
				this.detachHilight();
				this._hilight = new this.Highlighter(m.elem);
				return true;
			}

			if (evt.type == 'click') {
				if (evt.button === 0 && !!target &&
					target.nodeType == 1 &&
					(!target.namespaceURI || target.namespaceURI == 'http://www.w3.org/1999/xhtml')) {
					if (this._searchee.some(processRegular, this)) {
						this.cancelEvent(evt);
					}
				}
			}
			else if (evt.type == 'mousemove') {
				if (!this._searchee.some(highlightElement, this)) {
					this.detachHilight();
				}
			}
		},
		observe: function() {
			let searchee = [
				['a', 'href'],
				['img', 'src']
			];
			if (Preferences.getExt('selectbgimages', false)) {
				searchee.push(['bgimg', 'bgimg']);
			}
			this._searchee = searchee;
		}
	};

	Selector.prototype.Flasher = function(elem) {
		this.elem = elem;
		this.doc = elem.ownerDocument;
		this.init();
	};
	Selector.prototype.Flasher.prototype = {
		BACKGROUND: '#1def39 no-repeat center',
		PADDING: 6,
		OPACITY: 0.6,
		RADIUS: 5,
		FSTEP: 0.05,
		FINTERVAL: 60,
		FWAIT: 350,

		calcPosition: function(parent) {
			let ow = parent.offsetWidth;
			let oh = parent.offsetHeight;
			let ol = parent.offsetLeft;
			let ot = parent.offsetTop;
			// enlarge the box to include all (overflowing) child elements
			// useful for example for inline <A><IMG></A>
			if (parent.nodeName != 'IMG') {
				let boxen = parent.getElementsByTagName('*');
				for (let i = 0; i < boxen.length; ++i) {
					let box = boxen[i];
					if (!!box.style.float || box.style.position == 'fixed' || box.style.position == 'absolute') {
						continue;
					}
					ow = Math.max(ow, box.offsetWidth);
					oh = Math.max(oh, box.offsetHeight);
					ol = Math.min(ol, box.offsetLeft);
					ot = Math.min(ot, box.offsetTop);
				}
			}
			// calculate the real offset coordinates
			parent = parent.offsetParent;
			let pos = (this.elem.style.position && this.elem.style.position == 'fixed') ? 'fixed' : 'absolute';
			while (parent) {
				ot += parent.offsetTop;
				ol += parent.offsetLeft;
				if (parent.style.position == 'fixed') {
					pos = 'fixed';
				}
				parent = parent.offsetParent;
			}
			return {
				width: ow,
				height: oh,
				left: ol,
				top: ot,
				position: pos
			};
		},

		init: function() {
			let div = this.doc.createElement('div');
			this.doc.documentElement.appendChild(div);

			div.style.MozBorderRadius = this.RADIUS + 'px';
			div.style.zIndex = 2147483647;
			div.style.opacity = this.OPACITY;
			div.style.background = this.BACKGROUND;
			div.style.display = 'block';

			// put the div where it belongs
			let pos = this.calcPosition(this.elem);
			div.style.width = (pos.width + 2 * this.PADDING) + "px";
			div.style.height = (pos.height + 2 * this.PADDING) + "px";
			div.style.top = (pos.top - this.PADDING) + "px";
			div.style.left = (pos.left - this.PADDING) + "px";
			div.style.position = pos.position;

			// add the adding icon if the element covers enough space
			if (Math.min(pos.width, pos.height) >= 36) {
				div.style.backgroundImage = 'url(chrome://dta-public/skin/integration/added_large.png)';
			}
			if (Math.min(pos.width, pos.height) >= 18) {
				div.style.backgroundImage = 'url(chrome://dta-public/skin/integration/added_small.png)';
			}

			this._div = div;
		},
		fade: function() {
			let o = (parseFloat(this._div.style.opacity) - this.FSTEP);
			if (o - 0.03 < 0) {
				this._div.parentNode.removeChild(this._div);
				return false;
			}
			this._div.style.opacity = o.toString();
			let tp = this;
			setTimeoutOnlyFun(function() tp.fade(), this.FINTERVAL);
			return true;
		},
		hide: function() {
			let tp = this;
			setTimeoutOnlyFun(function() tp.fade(), this.FWAIT);
		}
	};

	Selector.prototype.Highlighter = function(elem) {
		this.elem = elem;
		this.doc = elem.ownerDocument;
		this.init();
	};
	Selector.prototype.Highlighter.prototype = {
		BACKGROUND: 'red',
		OPACITY: 0.4,
		RADIUS: 9,
		WIDTH: 3,

		calcPosition: Selector.prototype.Flasher.prototype.calcPosition,

		init: function() {
			let doc = this.doc;
			let elem = doc.documentElement;
			function div() doc.createElement('div');

			let leftD = div();
			elem.appendChild(leftD);
			let rightD = div();
			elem.appendChild(rightD);
			let topD = div();
			elem.appendChild(topD);
			let bottomD = div();
			elem.appendChild(bottomD);

			this._divs = [leftD, rightD, topD, bottomD];

			let pos = this.calcPosition(this.elem);
			for (let div of this._divs) {
				div.style.zIndex = 2147483647;
				div.style.opacity = this.OPACITY;
				div.style.background = this.BACKGROUND;
				div.style.display = 'block';
				div.style.position = pos.position;
				div.style.width = this.WIDTH + 'px';
				div.style.height = this.WIDTH + 'px';
			}

			leftD.style.MozBorderRadiusTopleft = this.RADIUS + 'px';
			leftD.style.MozBorderRadiusBottomleft = this.RADIUS + 'px';
			leftD.style.left = (pos.left - this.WIDTH) + 'px';
			leftD.style.top = (pos.top - this.WIDTH) + 'px';
			leftD.style.height = (pos.height + this.WIDTH * 2) + 'px';

			rightD.style.MozBorderRadiusTopright = this.RADIUS + 'px';
			rightD.style.MozBorderRadiusBottomright = this.RADIUS + 'px';
			rightD.style.top = leftD.style.top;
			rightD.style.left = (pos.left + pos.width) + 'px';
			rightD.style.height = leftD.style.height;

			topD.style.left = pos.left + 'px';
			topD.style.top = (pos.top - this.WIDTH) + 'px';
			topD.style.width = pos.width + 'px';

			bottomD.style.left = pos.left + 'px';
			bottomD.style.top = (pos.top + pos.height) + 'px';
			bottomD.style.width = pos.width + 'px';
		},
		hide: function() {
			for (let div of this._divs) {
				div.parentNode.removeChild(div);
			}
		}
	};

	function setupDrop(elem, func) {
		function ondragover(event) {
			try {
				if (event.dataTransfer.types.contains("text/x-moz-url")) {
					event.dataTransfer.dropEffect = "link";
					event.preventDefault();
				}
			}
			catch (ex) {
				log(LOG_ERROR, "failed to process ondragover", ex);
			}
		}
		function ondrop(event) {
			Task.spawn(function*() {
				try {
					let url = event.dataTransfer.getData("URL");
					if (!url) {
						return;
					}
					url = Services.io.newURI(url, null, null);
					url = new DTA.URL(DTA.getLinkPrintMetalink(url) || url);
					let {ref, title} = yield getFocusedDetails();
					ref = ref && Services.io.newURI(ref.spec, ref.originCharset, null);
					func(url, ref);
				}
				catch (ex) {
					log(LOG_ERROR, "failed to process ondrop", ex);
				}
			});
		}
		elem.addEventListener("dragover", ondragover, true);
		elem.addEventListener("drop", ondrop, true);
		unloadWindow(window, function() {
			elem.removeEventListener("dragover", ondragover, true);
			elem.removeEventListener("drop", ondrop, true);
		});
	}

	function $t() {
		let rv = [];
		for (let i = 0, e = arguments.length; i < e; ++i) {
			let id = arguments[i];
			let element = document.getElementById(id);
			if (element) {
					rv.push(element);
					continue;
			}
			if (id in paletteItems) {
				rv.push(paletteItems[id]);
				continue;
			}
		}
		return rv.length == 1 ? rv[0] : rv;
	}

	(function initMenusAndCommands(evt) {
		function bindEvt(evt, fn) {
			return function (e) {
				e.addEventListener(evt, fn, true);
				unloadWindow(window, function() e.removeEventListener(evt, fn, true));
			};
		}

		try {
			let cont = $('dtaCtxSubmenu');

			for (let id of MENU_ITEMS) {
				compact[id] = $('dtaCtx' + id);
				let node = $('dtaCtx' + id).cloneNode(true);
				node.setAttribute('id', node.id + "-direct");
				ctx.insertBefore(node, ctxBase.nextSibling);
				direct[id] = node;
				unloadWindow(window, function() node.parentNode.removeChild(node));
			}

			// prepare tools
			for (let e of ['DTA', 'TDTA', 'Manager']) {
				tools[e] = $('dtaTools' + e);
			}

			let f = bindEvt("command", function() findLinks(false));
			f($("dta:regular"));
			f($("dta:regular-sel"));
			bindEvt("command", function() findLinks(false, true))($("dta:regular-all"));
			bindEvt("command", function() findSingleLink(false))($("dta:regular-link"));
			bindEvt("command", function() findSingleImg(false))($("dta:regular-img"));
			bindEvt("command", function() findSingleVideo(false))($("dta:regular-video"));
			bindEvt("command", function() findSingleAudio(false))($("dta:regular-audio"));
			bindEvt("command", function() findSingleForm(false))($("dta:regular-form"));
			bindEvt("command", function(e) findSniff(e, false))($("dta:regular-sniff"));

			f = bindEvt("command", function() findLinks(true));
			f($("dta:turbo"));
			f($("dta:turbo-sel"));
			bindEvt("command", function() findLinks(true, true))($("dta:turbo-all"));
			bindEvt("command", function() findSingleLink(true))($("dta:turbo-link"));
			bindEvt("command", function() findSingleImg(true))($("dta:turbo-img"));
			bindEvt("command", function() findSingleVideo(true))($("dta:turbo-video"));
			bindEvt("command", function() findSingleAudio(true))($("dta:turbo-audio"));
			bindEvt("command", function() findSingleForm(true))($("dta:turbo-form"));
			bindEvt("command", function(e) findSniff(e, true))($("dta:turbo-sniff"));

			bindEvt("command", function() toggleOneClick())($("dta:turboselect"));
			bindEvt("command", function() DTA.openManager(window))($("dta:manager"));
			bindEvt("command", function() Mediator.showPreferences(window))($("dta:prefs"));
			bindEvt("command", function() Mediator.showToolbarInstall(window))($("dta:tbinstall"));
			bindEvt("command", function() Mediator.showAbout(window))($("dta:about"));

			bindEvt("popupshowing", onContextShowing)(ctx);
			bindEvt("popupshowing", onToolsShowing)(menu);
		}
		catch (ex) {
			Components.utils.reportError(ex);
			log(LOG_ERROR, "DCO::init()", ex);
		}
	})();

	/*window.addEventListener("keydown", onKeyDown, false);
	unloadWindow(window, function() window.removeEventListener("keydown", onKeyDown, false));

	window.addEventListener("keyup", onKeyUp, false);
	unloadWindow(window, function() window.removeEventListener("keyup", onKeyUp, false));

	window.addEventListener("blur", onBlur, true);
	unloadWindow(window, function() window.removeEventListener("blur", onBlur, true));*/

	let appcontent = document.getElementById("appcontent");
	if (appcontent) {
		appcontent.addEventListener("DOMContentLoaded", onToolbarInstall, true);
		unloadWindow(window, function() appcontent.removeEventListener("DOMContentLoaded", onToolbarInstall, true));
	}

	/* Toolbar buttons */

	// Santas little helper, palette items + lookup
	let paletteItems = {};
	try {
		let palette = $('navigator-toolbox').palette;
		for (let c = palette.firstChild; c; c = c.nextSibling) {
			if (c.id) {
				paletteItems[c.id] = c;
			}
		}
	}
	catch (ex) {
		log(LOG_ERROR, "Failed to parse palette", ex);
	}

	try {
		(function() {
			function onCommand(e) {
				let el = e.target;
				if (el.getAttribute("cui-areatype") === "menu-panel") {
					try {
						let ownerWindow = el.ownerDocument.defaultView;
						let {area} = ownerWindow.CustomizableUI.getPlacementOfWidget(el.id);
						let view = el.getAttribute("panelview");
						onDTAViewShowing(el, $(view));
						ownerWindow.PanelUI.showSubView(view, el, area);
						e.preventDefault();
						return false;
					}
					catch (ex) {
						log(LOG_ERROR, "failed to show panel", ex);
					}
				}
				$(el.getAttribute("buttoncommand")).doCommand();
			}
			let dta_button = $t('dta-button');
			dta_button.addEventListener('popupshowing', onDTAShowing, true);
			unloadWindow(window, function() dta_button.removeEventListener('popupshowing', onDTAShowing, true));
			dta_button.addEventListener('command', onCommand, true);
			unloadWindow(window, function() dta_button.removeEventListener('command', onCommand, true));

			setupDrop(dta_button, function(url, ref) {
				DTA.saveSingleItem(window, false, {
					"url": url,
					"referrer": ref,
					"description": "",
					"isPrivate": isWindowPrivate(window)
				});
			});

			let dta_turbo_button = $t('dta-turbo-button');
			dta_turbo_button.addEventListener('popupshowing', onDTAShowing, true);
			unloadWindow(window, function() dta_turbo_button.removeEventListener('popupshowing', onDTAShowing, true));
			dta_turbo_button.addEventListener('command', onCommand, true);
			unloadWindow(window, function() dta_turbo_button.removeEventListener('command', onCommand, true));

			setupDrop(dta_turbo_button, function(url, ref) {
				let item = {
					"url": url,
					"referrer": ref,
					"description": "",
					"isPrivate": isWindowPrivate(window)
				};
				try {
					DTA.saveSingleItem(window, true, item);
				}
				catch (ex) {
					log(LOG_ERROR, "failed to turbo drop, retrying normal", ex);
					DTA.saveSingleItem(window, false, item);
				}
			});

			unloadWindow(window, function() detachOneClick);
		})();
	}
	catch (ex) {
		log(LOG_ERROR, "Init TBB failed", ex);
	}

	if (outerEvent) {
		log(LOG_DEBUG, "replaying event");
		let target = outerEvent.target;
		let type = outerEvent.type;
		if (type == "popupshowing") {
			switch(target.id) {
				case "menu_ToolsPopup":
					onToolsShowing(outerEvent);
					break;
				case "contentAreaContextMenu":
					onContextShowing(outerEvent);
					break;
				default:
					log(LOG_DEBUG, "dispatching new event");
					let replayEvent = document.createEvent("Events");
					replayEvent.initEvent(type, true, true);
					target.dispatchEvent(replayEvent);
					break;
			}
		}
		else if (type == "command" && target.id != "cmd_CustomizeToolbars") {
			target.doCommand();
		}
	}
	log(LOG_DEBUG, "dTa integration done");
};
