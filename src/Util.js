/**
 * Util.js
 */
'use strict';

exports.invoke = function invoke(collection, method, ...args) {
	var i, itm;
	for (i in collection) {
		itm = collection[i];
		if (!itm[method])
			continue;
		itm[method].apply(itm, args);
	}
};

// combine to bytes into single unicode byte
exports.toUnicode = function toUnicode(a, b) {
	a += 127;
	b += 127;
	return String.fromCharCode((a << 8) + b);
};

exports.fromUnicode = function fromUnicode(character) {
	const integer = character.charCodeAt(0);
	return [(integer >> 8) - 127, (integer & 255) - 127];
};

// combine two 16 bit values into a single 32 bit
exports.combine = function combine(a, b) {
	return (a << 16) + b;
};

exports.seperate = function seperate(integer) {
	return [(integer >> 16), (integer & 0x0000FFFF)];
};

exports.hasGetter = function hasGetter(prot, prop) {
	return Object.getOwnPropertyDescriptor(prot, prop).get !== undefined;
};

/**
 * or _.find(array, s=> _.indexOf(secondArray, s) == -1)
 */
exports.firstThingNotInOtherArray = function firstThingNotInOtherArray(array, secondArray) {
	var result;
	for (var i = 0, l = array.length; i < l; i++) {
		if (secondArray.indexOf(array[i]) === -1) { result = array[i]; break; }
	}
	return result;
};

/**
 * Shift items off the front of the array while
 * predicate returns truthy.
 */
exports.shiftWhile = function shiftWhile(arr, fn, act) {
	if (!_.isArray(arr))
		throw new TypeError("Expected array");
	var item;
	while (arr.length && fn(arr[0])) {
		item = arr.shift();
		if (act)
			act(item);
	}
	return arr;
};

/** 
 * Run-length encode an array
 * @param [Number]
 * @return [Number]
 * ex: Time.measure( () => Util.RLE((new CostMatrix.CostMatrix()).serialize()) ) // 0.42 cpu
 * ex: Time.measure( () => Util.RLE((new CostMatrix.CostMatrix()).serialize()) )
 * ex: Time.measure( () => Util.RLE(Memory.rooms['E59S42'].cm.obstacle) ) // 0.05
 */
exports.RLE = function RLE(arr) {
	if (!arr || !arr.length)
		throw new Error("RLE expects non-empty array");

	var r = [];
	var m = 0;
	var c = 1;

	for (var i = 1; i < arr.length; i++) {
		if (arr[i] === arr[i - 1])
			c++;
		else {
			r[m++] = c;
			r[m++] = arr[i - 1];
			c = 1;
		}
	}
	r[m++] = c;
	r[m++] = arr[i - 1];
	return r;
};

/** 
 * Run-length decode an array
 * @param [Number]
 * @return [Number]
 */
exports.RLD = function RLD(arr) {
	if (!arr || !arr.length)
		throw new Error("RLD expects non-empty array");
	var i, j, c, v, r = [];
	for (i = 0; i < arr.length; i += 2) {
		c = arr[i];
		v = arr[i + 1];
		for (j = 0; j < c; j++)
			r.push(v);
	}
	return r;
};

/**
 * from Dissi!
 */
exports.getColorBasedOnPercentage = function getColorBasedOnPercentage(thePercentage) {
	var hue = Math.floor((100 - thePercentage) * 120 / 100);  // go from green to red
	var saturation = Math.abs(thePercentage - 50) / 50;
	return exports.hsv2rgb(hue, saturation, 1);
};

// spedwards
exports.getColourByPercentage = function getColourByPercentage(percentage, reverse) {
	const value = reverse ? percentage : 1 - percentage;
	const hue = (value * 120).toString(10);
	return `hsl(${hue}, 100%, 50%)`;
};

exports.getColorRange = function getColorRange(max) {
	var colors = [];
	for (var i = 0; i < max; i++)
		colors.push(exports.getColorBasedOnPercentage(100 * (i / max)));
	return colors;
};

/**
 *
 */
exports.hsv2rgb = function hsv2rgb(h, s, v) {
	// adapted from http://schinckel.net/2012/01/10/hsv-to-rgb-in-javascript/
	var rgb, i, data = [];
	if (s === 0) {
		rgb = [v, v, v];
	} else {
		h = h / 60;
		i = Math.floor(h);
		data = [v * (1 - s), v * (1 - s * (h - i)), v * (1 - s * (1 - (h - i)))];
		switch (i) {
			case 0:
				rgb = [v, data[2], data[0]];
				break;
			case 1:
				rgb = [data[1], v, data[0]];
				break;
			case 2:
				rgb = [data[0], v, data[2]];
				break;
			case 3:
				rgb = [data[0], data[1], v];
				break;
			case 4:
				rgb = [data[2], data[0], v];
				break;
			default:
				rgb = [v, data[0], data[1]];
				break;
		}
	}
	return '#' + rgb.map(function (x) {
		return ("0" + Math.round(x * 255).toString(16)).slice(-2);
	}).join('');
};

exports.runCensus = function runCensus() {
	if (Game.census == null) {
		const creepsFiltered = _.reject(Game.creeps, c => c.ticksToLive != null && c.ticksToLive <= UNIT_BUILD_TIME(c.body) + (DEFAULT_SPAWN_JOB_EXPIRE - 1));
		Game.census = _.groupBy(creepsFiltered, c => `${c.memory.home || c.memory.origin || c.pos.roomName}_${c.memory.role}`);
		Game.creepsByRoom = _.groupBy(creepsFiltered, c => `${c.memory.home || c.memory.origin || c.pos.roomName}`);
		// Game.censusFlags = _.groupBy(Game.flags, f => `${f.color}_${f.secondaryColor}`);
		Log.debug(`Generating census report`, 'Controller');
	}
	return Game.census;
};