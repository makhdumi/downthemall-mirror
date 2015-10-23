/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const {formatNumber} = require("utils");
const Prefs = require("preferences");
const {
	replaceSlashes,
	getUsablePath,
	getUsableFileName,
	getUsableFileNameWithFlatten
} = require("support/stringfuncs");

var seriesDigits;

Prefs.addObserver("extensions.dta.seriesdigits", ({
	observe: function() {
		seriesDigits = Prefs.getExt("seriesdigits", 3);
		return this;
	}
}).observe());

const expr = /\*\w+\*/gi;

const Renamer = {
	get name() this._o.fileNameAndExtension.name,
	get ext() this._o.fileNameAndExtension.extension,
	get text() replaceSlashes(this._o.description, " ").trim(),
	get flattext() getUsableFileNameWithFlatten(this._o.description),
	get title() this._o.title.trim(),
	get flattitle() getUsableFileNameWithFlatten(this._o.title),
	get url() this._o.maskURL.host,
	get domain() this._o.urlManager.domain,
	get subdirs() this._o.maskURLPath,
	get flatsubdirs() getUsableFileNameWithFlatten(this._o.maskURLPath),
	get qstring() this._o.maskURL.query || '',
	get curl() getUsablePath(this._o.maskCURL),
	get flatcurl() getUsableFileNameWithFlatten(this._o.maskCURL),
	get refer() this._o.referrer ? this._o.referrer.host.toString() : '',
	get crefer() this._o.referrerUrlManager ? getUsablePath(this._o.maskReferrerCURL) : '',
	get referqstring() this._o.referrerUrlManager ? this._o.maskReferrerURL.query : '',
	get flatcrefer() this._o.referrerUrlManager ? getUsableFileNameWithFlatten(this._o.maskReferrerCURL) : '',
	get referdirs() this._o.referrerUrlManager ? this._o.maskReferrerURLPath : '',
	get flatreferdirs() this._o.referrerUrlManager ? getUsableFileNameWithFlatten(this._o.maskReferrerURLPath) : '',
	get refername() this._o.referrerFileNameAndExtension ? this._o.referrerFileNameAndExtension.name : '',
	get referext() this._o.referrerFileNameAndExtension ? this._o.referrerFileNameAndExtension.extension : '',
	get num() formatNumber(this._o.bNum, seriesDigits),
	get inum() formatNumber(this._o.iNum, seriesDigits),
	get hh() formatNumber(this._o.startDate.getHours(), 2),
	get mm() formatNumber(this._o.startDate.getMinutes(), 2),
	get ss() formatNumber(this._o.startDate.getSeconds(), 2),
	get d() formatNumber(this._o.startDate.getDate(), 2),
	get m() formatNumber(this._o.startDate.getMonth() + 1, 2),
	get y() this._o.startDate.getFullYear().toString()
};

Object.defineProperty(exports, "createRenamer", {
	value: function createRenamer(o) {
		const replacements = Object.create(Renamer, {"_o": {value: o}});
		const replace = function replace(type) {
			const t = type.substr(1, type.length - 2);
			return (t in replacements) ? replacements[t] : type;
		};
		return function replacer(mask) {
			return mask.replace(expr, replace);
		};
	},
	enumerable: true
});
