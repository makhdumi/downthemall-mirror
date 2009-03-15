/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is DownThemAll Utilities module.
 *
 * The Initial Developer of the Original Code is Nils Maier
 * Portions created by the Initial Developer are Copyright (C) 2008
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Nils Maier <MaierMan@web.de>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

const EXPORTED_SYMBOLS = [
	'atos',
	'newUUIDString',
	'range',
	'hexdigest',
	'merge',
	'clone',
	'formatNumber',
	'formatTimeDelta',
	'getTimestamp',
	'naturalSort',
	'SimpleIterator'
];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;



/**
 * returns a new UUID in string representation
 * @return String UUID
 * @author Nils
 */
function newUUIDString() {
	let uuidgen = Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator);
	
	newUUIDString = function() {
		return uuidgen.generateUUID().toString();
	}
	return newUUIDString();
}

/**
 * Range generator (python style). Difference: step direction is initialized accordingly if corresponding parameter is omitted.
 * @param start Optional. Start value (default: 0)
 * @param stop Stop value (exclusive)
 * @param step Optional. Step value (default: 1/-1)
 * @author Nils
 */
function range() {
	if (arguments.length == 0) {
		throw Components.results.NS_ERROR_INVALID_ARG;
	}
	let start = 0, stop = new Number(arguments[0]), step;
	if (arguments.length >= 2) {
		start = stop;
		stop = new Number(arguments[1]);
	}
	if (arguments.length >= 3) {
		step = new Number(arguments[2]);
	}
	else {
		step = stop - start > 0 ? 1 : -1; 
	}
	if (!isFinite(start) || !isFinite(stop) || !isFinite(step) || step == 0) {
		throw Cr.NS_ERROR_INVALID_ARG;
	}
	if ((stop - start) / step < 0) {
		// negative range
		return;
	}
	stop += -Math.abs(step) / step;
	stop += step - ((stop - start) % step);
	for (; start != stop; start += step) {
		yield start;
	}

}

/**
 * Builds the hexdigest of (binary) data
 * @param {Object} data
 * @return {String} hexdigest
 */
function hexdigest(data) {
	data = data.toString();
	return [('0' + data.charCodeAt(i).toString(16)).slice(-2) for (i in range(data.length))].join('');	
}

/**
 * Merges the enumeratable properties of two objects   
 * @param {Object} me Object that has the properties added the properties
 * @param {Object} that Object of which the properties are taken
 */
function merge(me, that) {
	for (let c in that) {
		me[c] = that[c];
	}
}

/**
 * (Almost) Clones an object. Not instanceof safe :p
 * @param {Object} obj
 * @return {Object} Copy of obj
 */
function clone(obj) {
	var rv = {};
	merge(rv, obj);
	merge(rv.prototype, this.prototype);
	rv.constructor = this.constructor;
	return rv;
}

/**
 * Cast non-strings to strings (using toSource if required instead of toString()
 * @param {Object} data
 */
function atos(data) {
	if (typeof(data) == 'string') {
		return data;
	}
	if (data instanceof String || typeof(data) == 'object') {
		try {
			return data.toSource();
		}
		catch (ex) {
			// fall-trough
		}
	}
	return data.toString();
}

/**
 * Head-Pads a number so that at it contains least "digits" digits.
 * @param {Object} num The number in question
 * @param {Object} digits Number of digits the results must contain at least
 */
function formatNumber(num, digits) {
	let rv = atos(num);
	digits = Number(digits);
	if (!isFinite(digits)) {
		digits = 3;
	}
	for (let i = rv.length; i < digits; ++i) {
		rv = '0' + rv;
	}
	return rv;
}

/**
 * Formats a time delta (seconds)
 * @param {Number} delta in seconds
 * @return {String} formatted result
 */
function formatTimeDelta(delta) {
	let rv = (delta < 0) ? '-' : '';

	delta = Math.abs(delta);
	let h = Math.floor(delta / 3600);
	let m = Math.floor((delta % 3600) / 60);
	let s = Math.floor(delta % 60);
	
	if (h) {
		rv += formatNumber(h, 2) + ':';
	}
	return rv + formatNumber(m, 2) + ':' + formatNumber(s, 2);
}

/**
 * Converts a Datestring into an integer timestamp.
 * @param {Object} str Datestring or null for current time.
 */
function getTimestamp(str) {
	if (!str) {
		return Date.now();
	}
	let rv = Date.parse(atos(str));
	if (!isFinite(rv)) {
		throw new Error('invalid date');
	}
	return rv;
}

function naturalSort(arr, mapper) {
	if (typeof mapper != 'function' && !(mapper instanceof Function)) {
		mapper = function(e) e;
	}
	let isDigit = function(a, i) {
		i = a[i];
		return i >= '0' && i <= '9';
	};
	let compare = function(a, b) {
		return a === b ? 0 : (a < b ? -1 : 1);
	}
	arr = arr.map(
		function(b) {
			let e = mapper(b);
			if (e == null || e == undefined || typeof e == 'number') {
				return {elem: b, chunks: [e]};
			}
			let a = e.toString().replace(/\b(?:a|one|the)\b/g, ' ').replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ').toLowerCase();
			let len = a.length;
			if (!len) {
				return {elem: b, chunks: [a]};
			}
			let rv = [];
			let last = isDigit(a, 0);
			let cur = last;
			start = 0;
		
			for (let i = 0; i < len; ++i) {
				cur = isDigit(a, i);
				if (cur != last) {
					rv.push(cur ? a.substr(start, i - start) : Number(a.substr(start, i - start)));
					start = i;
					last = cur;
				}
			}
			if (!rv.length || len - start != 1) {
				rv.push(cur ? Number(a.substr(start)) : a.substr(start));
			}
			return {elem: b, chunks: rv};
		}
	);
	arr.sort(
		function (a, b) {
			let ai, bi;
			[a, b] = [a.chunks, b.chunks];
			let m = Math.max(a.length, b.length);
			for (let i = 0; i < m; ++i) {
				let ai = a[i], bi = b[i];
				let rv = compare(typeof ai, typeof bi);
				if (rv) {
					return rv;
				}
				rv = compare(ai, bi);
				if (rv) {
					return rv;
				}
			}
			return a.length - b.length;
		}
	);
	return arr.map(function(a) a.elem);
}

function SimpleIterator(obj, iface) {
	this.iface = iface ? iface : Ci.nsISupport;
	this.obj = obj.QueryInterface(Ci.nsISimpleEnumerator);
}
SimpleIterator.prototype = {
	__iterator__: function() {
		while(this.obj.hasMoreElements()) {
			yield this.obj.getNext().QueryInterface(this.iface);
		}
	}
};