/**
 * ext/structure.nuker.js - A wildly ineffective weapon
 *
 *   The nuker can hit any room in range 10, striking a tiny radius for millions of hp
 * in damage and killing all the creeps in the room. But it takes a real life week to cooldown, 
 * 2.5 days to land, and a fair amount of ghodium.
 *
 * @todo If we're under threat and we're loaded, fire on pre-programmed target!
 * @todo Check intel for friendly rooms.
 * @todo Schedule post-landing cleanup party.
 */
'use strict';

import { ENVC } from '/os/core/macros';
import { RLD } from '/lib/util';
import { INVADER_USERNAME } from '/os/core/constants';
import { TERMINAL_MAINTAIN_RESERVE } from '/proto/structure/terminal';
import NukeGrid from '/ds/NukeGrid';
import { Log, LOG_LEVEL } from '/os/core/Log';

/* global Log, DEFINE_CACHED_GETTER, Filter */
/* eslint-disable consistent-return, prefer-destructuring */

export const MINIMUM_LEVEL_FOR_NUKER = _.findKey(CONTROLLER_STRUCTURES[STRUCTURE_NUKER]);

const DEFAULT_LAUNCH_DELAY = 8000;		// Delay in ticks before firing, in case we've made an error.
const ON_ERROR_SLEEP_DELAY = 100;
const NUKER_EARLY_READY_WARNING = 500;
const NUKER_PRETARGET = 100;			// Number of ticks before launch to finalize target selection
const NUKE_RADIUS = 2;

const PANIC_RANGE = 5;
const IGNORE_IF_HP_OVER = ENVC('nuker.ignore_if_over', 10000, 1);

DEFINE_CACHED_GETTER(StructureNuker.prototype, 'armed', s => s.energy >= s.energyCapacity && s.ghodium >= s.ghodiumCapacity);
DEFINE_CACHED_GETTER(StructureNuker.prototype, 'ready', s => s.armed && s.cooldown <= 0);

StructureNuker.prototype.run = function () {
	if (this.cooldown > 1024 || this.isDeferred() || !this.isActive())
		return;

	if (this.cooldown === NUKER_EARLY_READY_WARNING)
		Log.notify(`Silo in ${this.pos.roomName} will be operational in ${this.cooldown} ticks`);

	if (this.cooldown === 1)
		Log.notify(`Silo ${this.pos.roomName} cooldown complete`);

	// Reload logic
	if (this.ghodium < this.ghodiumCapacity
		&& this.room.terminal !== undefined
		&& this.room.terminal.store[RESOURCE_GHODIUM] >= Math.min(TERMINAL_MAINTAIN_RESERVE, this.ghodiumCapacity - this.ghodium)
		&& _.findWhere(Game.creeps, { memory: { role: 'filler', dest: this.id } }) == null) {
		// Log.info('[Nuker] Requesting filler unit at ' + this.pos.roomName);
		this.runReload();
		this.defer(MAX_CREEP_SPAWN_TIME * 2);
		return;
	}

	if (this.isFailsafeTriggered()) {
		Log.error(`Nuker ${this.pos.roomName} failsafe trigger! Would strike: ${this.memory.failsafe}`, 'Nuker');
		// @todo FIRE A NUKE!
		this.defer(150);
	}

	this.processTargets();
};

StructureNuker.prototype.isFailsafeTriggered = function () {
	const { controller } = this.room;
	if (!this.memory.failsafe)
		return false;	// Can't failsafe if we don't have a target.
	if (controller.level === MINIMUM_LEVEL_FOR_NUKER && controller.ticksToDowngrade < 500)
		return true;
	const imminentDanger = !_.isEmpty(this.pos.findInRange(this.room.hostiles, PANIC_RANGE));
	if (_.all(this.room.hostiles, 'owner.username', INVADER_USERNAME))
		return false;
	if (imminentDanger && this.hitsEffective < IGNORE_IF_HP_OVER)
		return true;
	return false;
};

/**
 * 
 */
StructureNuker.prototype.processTargets = function () {
	var job, q = this.getQueue();
	if (!(job = q[0]))
		return;
	this.say(`${job.room} (${job.tick - Game.time})`, 'white');
	// If job is invalid, shift
	if (Game.time < job.tick - NUKER_PRETARGET || !this.ready)
		return;
	if (Game.map.getRoomLinearDistance(this.pos.roomName, job.room) > NUKE_RANGE)
		return q.shift();
	if (!job.pos) {
		return this.acquirePosition(job);
	}
	else {
		const visual = new RoomVisual(job.pos.roomName);
		visual.rect(
			-0.5 + job.pos.x - NUKE_RADIUS,
			-0.5 + job.pos.y - NUKE_RADIUS,
			(0.5 + NUKE_RADIUS) * 2,
			(0.5 + NUKE_RADIUS) * 2);
	}
	// If we have a delay, wait it out.
	if (job.tick - Game.time < 10)
		Log.warn(`${this.pos.roomName}: Firing in ${job.tick - Game.time}`, 'Nuker');
	if (Game.time < job.tick)
		return;
	try {
		const pos = new RoomPosition(job.pos.x, job.pos.y, job.pos.roomName);
		Log.warn(`${this.pos.roomName}: Firing at ${pos}`, 'Nuker');
		// launchNuke
		const status = this.launchNuke(pos);
		if (status !== OK)
			Log.error(`${this.pos.roomName}: Launch to ${pos} failed with status ${status}`, 'Nuker');
	} catch (e) {
		Log.error(`${this.pos.roomName}: Silo exception ${e}`, 'Nuker');
		Log.error(e.stack, 'Nuker');
		this.defer(ON_ERROR_SLEEP_DELAY);
	}
	q.shift();
	// Adjust timer on next job
	if (q.length) {
		job = q[0];
		job.tick = Game.time + 1 + (NUKER_COOLDOWN - DEFAULT_LAUNCH_DELAY); // Line up for cooldown
	}
};

/**
 * Spawn filler to reload us.
 */
const NUKER_FILLER_BODY = RLD([4, CARRY, 4, MOVE]);
StructureNuker.prototype.runReload = function () {
	if (this.ghodium >= this.ghodiumCapacity)
		return ERR_FULL;
	const [spawn] = this.getClosestSpawn();
	const { terminal } = this.room;
	const memory = { role: 'filler', src: terminal.id, dest: this.id, res: RESOURCE_GHODIUM, amt: Math.min(this.ghodiumCapacity - this.ghodium, terminal.store[RESOURCE_GHODIUM]) };
	spawn.submit({ body: NUKER_FILLER_BODY, memory, priority: PRIORITY_MIN });
	return OK;
};

/**
 * Monkey patch nuker to prevent friendly targets
 */
const { launchNuke } = StructureNuker.prototype;
StructureNuker.prototype.launchNuke = function (pos) {
	if (Game.rooms[pos.roomName] && Game.rooms[pos.roomName].my)
		throw new Error("Unable to nuke friendly rooms");
	const status = launchNuke.apply(this, arguments);
	if (status === OK)
		Log.notify(`Nuclear launch detected! ${this.pos.roomName} to ${pos}`);
	return status;
};


/**
 * Priority queue list of targets
 */
StructureNuker.prototype.submitTarget = function (job) {
	const destRoomName = (job.pos && job.pos.roomName) || job.room;
	if (!job.tick)
		job.tick = Game.time + DEFAULT_LAUNCH_DELAY;
	if (!job.score)
		job.score = this.scoreTask(job);
	if (job.pos && !job.room)
		job.room = job.pos.roomName;
	if (Game.map.getRoomLinearDistance(this.pos.roomName, destRoomName) > this.getRange())
		return ERR_INVALID_TARGET;
	var q = this.getQueue();
	var i = _.sortedLastIndex(q, job, 'score');
	q.splice(i, 0, job);
	Log.warn(`New target ${destRoomName} added to list`, 'Nuker');
	return OK;
};

/**
 * Assign a score to the job so we can maintain the priority queue.
 * @todo how do we want to score our targets?
 */
StructureNuker.prototype.scoreTask = function (job) {
	return job.tick;
};

StructureNuker.prototype.getQueue = function () {
	if (!this.memory.list)
		this.memory.list = [];
	return this.memory.list;
};

StructureNuker.prototype.clearQueue = function () {
	var q = this.getQueue();
	return q.splice(0, q.length);
};

StructureNuker.prototype.isIdle = function () {
	return (this.getQueue().length <= 0);
};

StructureNuker.prototype.isInRange = function (destRoomName) {
	return Game.map.getRoomLinearDistance(this.pos.roomName, destRoomName, false) <= NUKE_RANGE;
};

/**
 * 
 */
StructureNuker.prototype.acquirePosition = function (job) {
	const room = Game.rooms[job.room];
	if (!room) {
		Log.debug(`${this.pos.roomName}: No visibility on ${job.room}`, 'Nuker');
		return this.room.observer.observeRoom(job.room);
	}
	// Target selection fun
	const g = NukeGrid.build(room);

	Log.warn(`${this.pos.roomName}: Target selection wants ${x},${y},${job.room} with score ${score}`, 'Nuker');
	job.pos = new RoomPosition(x, y, job.room);
};
