/**
 * ext/structure.controller.js - The centralized logic for each claimed room
 *
 *	The room controller is the single central decider for behavior of an owned room.
 * We have one per owned room, and only one. And they're already in Game.structures,
 * so the moment we claim a room it begins running.
 *
 * The room is as to the empire as a state is to a country.
 *
 * Functions:
 *	Unit census - Compares creeps we have versus creeps we need and adjusts
 *
 * Ideas:
 *  - Utility based AI / Goal based (What's the utility function for wall building?)
 *  - For automation purposes each room _really_ needs to know what rooms are next to it.
 *
 *
 * @todo Scale census against projected income (Single source rooms should work but be slower)
 * @todo Hapgrader. Adjusts projected income, projected rcl, and eliminates static upgrader and link.
 * @todo Size scavs better. Maybe based on projected income?
 * @todo Minerals in source list for SK rooms?
 * @todo Assign boosts to labs. Pick available compounds from the terminal with amount >= LAB_BOOST_MINERAL
 */
'use strict';

/* global DEFINE_CACHED_GETTER, Log, Filter, UNIT_BUILD_TIME */
/* global CREEP_UPGRADE_RANGE */
import * as Unit from '/Unit';
import { loadedTower } from '/lib/filter';
import { LogicError } from '/os/core/errors';
import { runCensus } from '/lib/util';
import { estimate } from '/lib/time';
import { CLAMP } from '/os/core/math';
import { MM_AVG } from '/os/core/math';
import { INVADER_USERNAME } from '/os/core/constants';
import { DATE_FORMATTER } from '/lib/time';
import { Log, LOG_LEVEL } from '/os/core/Log';
import { ENV } from '/os/core/macros';

/**
 * This is the rate we need to maintain to reach RCL 3 before safe mode drops.
 * Preferentially, we want to significantly exceed that so we have time to build the tower.
 */
const DESIRED_UPGRADE_RATE = (CONTROLLER_LEVELS[1] + CONTROLLER_LEVELS[2]) / SAFE_MODE_DURATION;

// Maximum upgraders:
// Math.pow((2*CREEP_UPGRADE_RANGE+1),2) - 1; // 48, max 49 work parts = 2352 ept

// @todo: FIND_HOSTILE_STRUCTURES, spawn bulldozer (doesn't have to be very big)
// @todo: Room goals (bunker raises defenses, expand pushes gcl) 
// @todo:
/* global.CONTROLLER_STATE_NORMAL = 0;		// Room is operational.
global.CONTROLLER_STATE_BOOTUP = 1;		// Create tiny units if we need to, just until extensions are fun.
global.CONTROLLER_STATE_HALT = 2;		// No spawning, load extensions.
global.CONTROLLER_STATE_ABANDON = 3;	// Offload resources to other rooms, prepare to unclaim
global.CONTROLLER_STATE_BREEDER_REACTOR = 4;	// Requires maintaining room energy < 300

// Reconnaissance - Scout adjacent rooms for sign of attack, gather cost matrix data, etc

global.BIT_CTRL_ANNOUNCE_ATTACKS = (1 << 1); // Do we notify on hostiles?
..bits instead of state maybe, or utility functions/scores.
*/

const SAFE_MODE_LOW_COOLDOWN = 2000;
const SAFE_MODE_LOW_TICKS = 4000;
const CONTROLLER_NOTIFICATION_DELAY = 100;

const CONTROLLER_SAFEMODE_MARGIN = 500;
const CONTROLLER_EMERGENCY_MODE_MULTIPLIER = 0.5;
const EMERGENCY_THRESHOLD = _.mapValues(CONTROLLER_DOWNGRADE, v => (v * CONTROLLER_EMERGENCY_MODE_MULTIPLIER) - CONTROLLER_DOWNGRADE_SAFEMODE_THRESHOLD + CONTROLLER_SAFEMODE_MARGIN);
const EMERGENCY_NOTIFICATION_THRESHOLD = _.mapValues(EMERGENCY_THRESHOLD, v => v - CONTROLLER_NOTIFICATION_DELAY);
const MINIMUM_REQUIRED_SAFE_MODE = 300;

/**
 * Custom properties
 */
DEFINE_CACHED_GETTER(StructureController.prototype, 'progressRemaining', con => con.progressTotal - con.progress);
DEFINE_CACHED_GETTER(StructureController.prototype, 'age', con => Game.time - con.memory.claimedAt);
DEFINE_CACHED_GETTER(StructureController.prototype, 'container', con => con.pos.getStructure(STRUCTURE_CONTAINER, CREEP_UPGRADE_RANGE, CREEP_UPGRADE_RANGE, s => _.isEmpty(s.lookForNear(LOOK_SOURCES))));

// Game.rooms['E59S39'].visual.rect(33-3,40-3,6,6)

// RCL 1: Micros. Whatever it takes. Upgrade to RCL 2.
// RCL 2: Safe mode. Static upgrader.
// RCL 3: Tower.
// RCL 4: Storage.  We have 20000 ticks till downgrade, ignore upgraders until we get storage up?
// RCL 5: Second tower. Link storage to controller.
StructureController.prototype.run = function () {
	this.updateRclAvg();
	this.updateLevel();
	this.updateSafeMode();
	//
	// Working countdown clock
	// let {x,y,roomName} = this.pos;
	// let newPos = new RoomPosition(x,y-1,roomName);
	// this.room.visual.text(this.ticksToDowngrade, newPos, {color: 'yellow'});

	if (this.level < MAX_ROOM_LEVEL) {
		const avgTick = _.round(this.memory.rclAvgTick, 2);
		const estimate = this.estimateInTicks();
		this.say(`${avgTick} (${estimate})`);
	}

	if (this.memory.relock && Game.time > this.memory.relock) {
		Log.warn(`Locking the front door in ${this.pos.roomName}`, 'Controller');
		_.invoke(this.room.structuresByType[STRUCTURE_RAMPART], 'setPublic', false);
		this.memory.relock = undefined;
	}
	if ((Game.time % (DEFAULT_SPAWN_JOB_EXPIRE + 1)) === 0) {
		try {
			var nukes = this.room.find(FIND_NUKES, { filter: n => n.timeToLand < MAX_CREEP_SPAWN_TIME });
			if (nukes && nukes.length) {
				var nuke = _.max(nukes, 'timeToLand');
				var defer = Math.min(MAX_CREEP_SPAWN_TIME, nuke.timeToLand + 1);
				Log.warn(`Census holding for ${defer} ticks, nuke inbound`, 'Controller');
				this.room.find(FIND_MY_SPAWNS).forEach(s => s.defer(defer));
				this.evacuate(Game.time + nuke.timeToLand + 1);
			} else {
				this.runCensus();
			}
		} catch (e) {
			Log.error(`Error in controller ${this.pos.roomName}: ${e}`);
			Log.error(e.stack);
		}
	}

	if (!(Game.time & 1023))
		this.updateNukeDetection();

	if (this.ticksToDowngrade === CONTROLLER_EMERGENCY_THRESHOLD) {
		Log.notify(`Low ticks to downgrade on room controller in ${this.pos.roomName}`);
	}

	// If we're about to lose the room, clean up.
	if (this.ticksToDowngrade === 2 && this.level === 1) {
		this.room.find(FIND_STRUCTURES).forEach(s => s.destroy());
		this.room.find(FIND_MY_CONSTRUCTION_SITES).forEach(s => s.remove());
		this.room.clearBuildQueue();
	}
	// What conditions to activate safe mode?

	// more stuff running the room! control low power mode. may be able to update room outside seperate room processor?
	// won't run in remote rooms!
};

/**
 * Emergency conditions
 *  No spawns: _.isEmpty(this.room.find(FIND_MY_SPAWNS));
 */
// Downgrades are an emergency
StructureController.prototype.isEmergencyModeActive = function () {
	// If we use maxlevel, they'll lock onto a downgraded controller and never stop.
	return (this.ticksToDowngrade <= EMERGENCY_THRESHOLD[this.level] || this.progress > this.progressTotal); // || this.memory.maxlevel > this.level);
};

/**
 * 
 */
StructureController.prototype.canEnablePower = function (offset = 0) {
	if (this.isPowerEnabled)
		return false;
	return this.my || (this.safeMode || 0) <= offset;
};

/**
 * Nuke detection - Exactly what it sounds like.
 *
 * @todo Group by time intervals so we don't waste safe modes.
 * @todo Switch to threat level model. Nuke sets to highest threat level forcing safe mode on next hostile action.
 */
// const MAX_NUKE_DEBOUNCE = 500;
StructureController.prototype.updateNukeDetection = function () {
	const nukes = this.room.find(FIND_NUKES);
	if (nukes == null || !nukes.length)
		return;
	Log.notify(`[DEFCON] Nuclear launch detected! ${this.pos.roomName}`);
	// const nukesByTimeGroup = _.groupBy(nukes, n => Math.floor(n.timeToLand / MAX_NUKE_DEBOUNCE));
	const maxNuke = _.max(nukes, 'timeToLand');
	const postNukeSafeMode = maxNuke.timeToLand + CONTROLLER_NUKE_BLOCKED_UPGRADE + _.random(1, 150);
	Log.debug(`${this.pos.roomName} Scheduling immediate safe mode following nuke arrival in ${postNukeSafeMode} ticks`, 'Controller');
	this.memory.postNukeSafeMode = postNukeSafeMode;
};

/**
 * 
 */
const CENSUS_ROLES = ['builder', 'defender', 'dualminer', 'healer', 'miner', 'pilot', 'repair', 'scav', 'scientist', 'scout', 'upgrader'];
/* StructureController.prototype.runAdaptiveCensus = function () {
	// Create census object (stats, spawns)
	// Get available spawns (by distance?)
	if (Game.census == null) {
		const creepsFiltered = _.filter(Game.creeps, c => c.ticksToLive == null || c.ticksToLive > UNIT_BUILD_TIME(c.body));
		Game.census = _.groupBy(creepsFiltered, c => `${c.memory.home || c.memory.origin || c.pos.roomName}_${c.memory.role}`);
		Game.creepsByRoom = _.groupBy(creepsFiltered, c => `${c.memory.home || c.memory.origin || c.pos.roomName}`);
		// Game.censusFlags = _.groupBy(Game.flags, f => `${f.color}_${f.secondaryColor}`);
		Log.debug(`Generating census report`, 'Controller');
	}
	const census = {
		creeps: Game.census,
		roomName: this.room.name,
		room: this.room,
		controller: this
	};
	for (const roleName of CENSUS_ROLES) {
		const role = require(`/role/${roleName}`);
		const want = (role.want && role.want(census)) || 0;
		if (!want)
			continue;
		const have = (role.have && role.have(census)) || (census.creeps[`${census.roomName}_${roleName}`] || []).length;
		const priority = (have / want); // lower is better, null for not wanted
		if (priority == null || priority === Infinity || have >= want)
			continue;
		const bodies = (role.body && role.body(census)) || role.minBody;
		Log.info(`Adaptive spawning: ${roleName} ${have} < ${want} (${priority})`, 'Controller');
		// figure out memory. beyond role, we _may_ need origin or home
		// find "best" spawn to submit job to.
		// const spawn = 
		// multiple bodies?
		// spawn.submit({ body, memory, priority, expire, notify });
	}
}; */

/**
 * Unit census - Expect this to be expensive
 * 
 * Basic premise - Since each creep expires or can be killed, there needs
 * to be a way to replace these missing creeps. Enter the census process.
 * this runs periodically to check what a room needs, what it has, and fix
 * the difference.
 *
 * Since our implementation of creep logic is role-based, so is our census.
 * For each census capable role we need:
 *   The role name
 *   A counter function (#creeps or #parts)
 *	 A desire function (#creeps or #parts desired)
 *	 An action function (for spawn or recycle)
 *   A spawn selector (ours, or a better option?)
 *
 * @todo: Priority should not be a role assigned constant. It should be a float between 0 and 1
 * based on current demand.
 *
 * @todo: If no towers, keep guard posted (low priorty over economy though).
 * @todo: If hostiles present, don't request repair creeps
 *
 * 2017-02-22: Support for memory-backed census jobs?
 * 2017-02-04: Repair units only spawn if we have a use for them
 * 2016-12-13: Increased maximum repair unit energy from 900 to 1800
 */
StructureController.prototype.runCensus = function () {
	var spawns = this.room.find(FIND_MY_SPAWNS);
	var [spawn] = spawns;
	const { storage, terminal } = this.room;
	const terminalEnergy = _.get(this.room, 'terminal.store.energy', 0);
	const storedEnergy = _.get(this.room, 'storage.store.energy', 0);
	var prio = 50;

	/** This is really all we need.. */
	/* if (Game.census == null) {
		const creepsFiltered = _.reject(Game.creeps, c => c.ticksToLive != null && c.ticksToLive <= UNIT_BUILD_TIME(c.body) + (DEFAULT_SPAWN_JOB_EXPIRE - 1));
		Game.census = _.groupBy(creepsFiltered, c => `${c.memory.home || c.memory.origin || c.pos.roomName}_${c.memory.role}`);
		Game.creepsByRoom = _.groupBy(creepsFiltered, c => `${c.memory.home || c.memory.origin || c.pos.roomName}`);
		// Game.censusFlags = _.groupBy(Game.flags, f => `${f.color}_${f.secondaryColor}`);
		Log.debug(`Generating census report`, 'Controller');
	} */
	runCensus(); // Get current census

	// Creeps
	const { roomName } = this.pos;
	const creeps = Game.creepsByRoom[roomName];
	const { census } = Game;

	const pilot = census[`${roomName}_pilot`] || [];
	const haulers = census[`${roomName}_hauler`] || [];
	const builders = census[`${roomName}_builder`] || [];
	const upgraders = census[`${roomName}_upgrader`] || [];
	const defenders = census[`${roomName}_defender`] || [];
	const healers = census[`${roomName}_healer`] || [];
	const repair = census[`${roomName}_repair`] || [];
	const scav = census[`${roomName}_scav`] || [];
	const bulldozer = census[`${roomName}_bulldozer`] || [];
	const scouts = census[`${roomName}_scout`] || [];
	const miners = census[`${roomName}_miner`] || [];
	const dualminers = census[`${roomName}_dualminer`] || [];
	const assistingSpawn = this.getAssistingSpawn();
	const signers = census[`${roomName}_signer`] || [];
	const scientists = census[`${roomName}_scientist`] || [];

	const resDecay = _.sum(this.room.resources, 'decay');
	const sites = this.room.find(FIND_MY_CONSTRUCTION_SITES);

	// Income
	const enDecay = _(this.room.resources).filter('resourceType', RESOURCE_ENERGY).sum('decay');
	const sources = this.room.find(FIND_SOURCES);
	const base = Math.min(_.sum(sources, 'ept'), _.sum(miners, 'harvestPower') + _.sum(dualminers, 'harvestPower'));
	const remote = Math.floor(_.sum(haulers, 'memory.ept')) || 0;
	const reactor = (this.room.energyAvailable >= SPAWN_ENERGY_START) ? 0 : spawns.length;
	const overstock = Math.floor((storage && storedEnergy * Math.max(0, storage.stock - 1) || 0) / CREEP_LIFE_TIME);
	const income = base + remote + reactor + overstock + enDecay;

	const upkeepCreeps = _.sum(creeps, 'cpt');
	const upkeepStructures = _.sum(this.room.structures, 'upkeep');
	const upkeep = upkeepCreeps + upkeepStructures;
	// const upkeep = upkeepStructures;

	const expense = 0;
	const net = income - (expense + upkeep);
	const avail = income - upkeep;
	const minimumAvailable = 0.25;
	const modifier = (!storage || !storage.isActive()) ? 1.0 : Math.max(minimumAvailable, storage.stock);
	const adjusted = avail * modifier; // Works, but is this the correct result?
	// const adjusted = income * modifier;

	// Distribution		
	const upperRepairLimit = 0.97;
	let allotedRepair = _.any(this.room.structures, s => s.hits / s.hitsMax < upperRepairLimit && CONSTRUCTION_COST[s.structureType]) ? CLAMP(1, Math.floor(adjusted * 0.25)) : 0;
	let allotedBuild = (sites && sites.length) ? Math.floor(adjusted * 0.70) : 0;
	const maxAllotedUpgrade = (this.level === MAX_ROOM_LEVEL) ? CONTROLLER_MAX_UPGRADE_PER_TICK : Infinity;
	let allotedUpgrade = CLAMP(0, Math.floor(adjusted - allotedRepair - allotedBuild), maxAllotedUpgrade); // Math.floor(Math.min(adjusted - allotedRepair - allotedBuild, maxAllotedUpgrade));
	try {
		/**
		 * Emergency conditions - Should probably be detected elsewhere
		 */
		let assistCost = 0;
		if (roomName === this.pos.roomName && (!creeps || !creeps.length)) { // Nothing alive, nothing about to spawn.
			Log.notify(`Emergency: No creeps in room ${roomName}!`, 'Controller');
			if (!spawn)
				[spawn, assistCost = 0] = this.getClosestSpawn({ plainCost: 2 });
			if (spawn) {
				Unit.requestPilot(spawn, roomName);
				return;
			}
		}

		/**
		 * Census failover operations
		 */
		if (!spawn || spawn.isDefunct()) {
			// Log.warn('No spawn or spawn is defunct, failover to assisting spawn', 'Controller');
			spawn = assistingSpawn;
			if (!spawn)
				[spawn, assistCost = 0] = this.getClosestSpawn({ plainCost: 2 });
			if (!spawn)
				[spawn] = _.values(Game.spawns);
		}

		if (!spawn) {
			Log.warn(`No spawn available for ${this.pos.roomName}`, 'Controller');
			return;
		}

		if (spawn && assistingSpawn)
			Log.debug(`${this.pos.roomName} Controller using spawn ${spawn.name}/${spawn.pos} and ${assistingSpawn.name}/${assistingSpawn.pos} `, 'Controller');

		if (!signers.length) {
			if (this.memory.report == null && this.sign && this.sign.text)
				spawn.submit({ memory: { role: 'signer', room: this.pos.roomName, msg: '' }, priority: PRIORITY_MIN });
			else if (this.memory.report && (!this.sign || this.sign.text !== this.memory.report))
				spawn.submit({ memory: { role: 'signer', room: this.pos.roomName, msg: this.memory.report }, priority: PRIORITY_MIN });
		}

		// var sourcesByRoom = _.groupBy(sources, 'pos.roomName');
		var numSources = sources.length;
		var dual = false;
		// @todo: If we start adding sources to this list, how is this supposed to work?
		// @todo: Start requesting dedicated, assigned haulers?
		const MAX_STORAGE_PCT = 0.90;
		// if(!this.room.storage || this.room.storage.storedPct < MAX_STORAGE_PCT) {
		if (numSources === 2 && this.level >= 6) {
			var totalCapacity = _.sum(sources, s => s.getCapacity());
			// If we have miners currently skip..
			const dualminer = _.findWhere(dualminers, { memory: { home: roomName, role: 'dualminer' } });
			if (!dualminer) {
				if (!this.cache.steps || this.cache.steps < 0) {
					const [s1, s2] = sources;
					const s1pos = new RoomPosition(s1.pos.x, s1.pos.y, s1.pos.roomName);
					const s2pos = new RoomPosition(s2.pos.x, s2.pos.y, s2.pos.roomName);
					this.cache.steps = s1pos.getStepsTo({ pos: s2pos, range: 1 }) * 2; // expecting two sources
					Log.debug(`${this.pos.roomName} steps: ${this.cache.steps}`, 'Controller');
				}
				const minerpri = (adjusted <= 0) ? PRIORITY_MAX : PRIORITY_MED;
				const result = _.attempt(() => Unit.requestDualMiner(spawn, this.pos.roomName, totalCapacity, this.cache.steps, minerpri));
				if (result !== false && !(result instanceof Error)) {
					// Log.warn('Requesting dual miner at ' + roomName + ' from ' + spawn.pos.roomName);
					dual = true;
				}
			} else {
				dual = true;
			}
		}
		if (dual !== true) {
			for (const source of sources) {
				// Obect form filter doesn't work anymore
				const forSource = _.filter(miners, c => source.pos.isEqualToPlain(c.memory.dest)); // No role check, we already know it's a miner for this room.
				if (_.any(forSource, { ticksToLive: undefined }))
					continue; // If we're currently spawning a creep, skip the rest.
				const [, cost,] = source.getClosestSpawn({}, 'cache');
				const spots = source.getAvailablePositions().length;
				const valid = _.filter(forSource, c => c.ticksToLive >= UNIT_BUILD_TIME(c.body) + (assistCost || cost));
				const rem = spots - valid.length;
				const sum = _.sum(valid, c => c.getBodyParts(WORK));
				Log.debug(`${source} has ${sum} work parts, desired ${source.harvestParts}, spots ${spots}, rem: ${rem}`, 'Controller');
				if (sum >= source.harvestParts || rem <= 0)
					continue;
				const minerpri = (adjusted <= 0) ? PRIORITY_MAX : (sum / source.harvestParts);
				if (this.room.energyCapacityAvailable < 600)
					Unit.requestMiner(assistingSpawn || spawn, source, minerpri);
				else
					Unit.requestMiner(spawn || assistingSpawn, source, minerpri);
			}
		}

		const MAX_BUILD_DESIRED = 20 * BUILD_POWER; // 160 e/t if we have storage?
		const buildAssigned = _.sum(builders, c => c.getBodyParts(WORK)) * BUILD_POWER;
		const buildDesired = Math.max(allotedBuild, (storage && storage.stock * MAX_BUILD_DESIRED || 0));
		if (sites && sites.length && buildAssigned < buildDesired) {
			Log.debug(`Build: ${buildAssigned}/${buildDesired}`, 'Controller');
			// const buildRemaining = _.sum(sites, s => s.progressTotal - s.progress);	// Total energy required to finish all builds
			// const score = Math.ceil(buildRemaining / CREEP_LIFE_TIME / BUILD_POWER);
			// console.log('build remaining in room: ' + score);
			// score = CLAMP(0, score, 3);
			let useSpawn = spawn || assistingSpawn;
			// Past a certain point it doesn't make sense to use. Otherwise mix things up.
			if (this.level < 6 && assistingSpawn && Math.random() < 0.5)
				useSpawn = assistingSpawn;
			if (!useSpawn)
				Log.warn(`No spawn available to request builders for ${this.pos.roomName}`, 'Controller');
			prio = CLAMP(0, Math.ceil(100 * (buildAssigned / buildDesired)), 90);
			// var elimit = (storedEnergy > 10000) ? Infinity : (10 * numSources);
			Unit.requestBuilder(useSpawn, { elimit: buildDesired, home: roomName, priority: prio });
		}

		// Defenders
		// @todo If not enclosed, requesting ranged kiters.
		// @todo Compare my damage output versus heal in the room.
		if ((this.safeMode || 0) < SAFE_MODE_IGNORE_TIMER) {
			const towers = _.size(this.room.find(FIND_MY_STRUCTURES, { filter: loadedTower }));
			// if (!_.isEmpty(hostiles) && room.my && (towers <= 0 || hostiles.length > towers)) {
			if (towers <= 0 || this.room.hostiles.length > towers) {
				const desired = CLAMP(1, this.room.hostiles.length * 2, 8);
				for (var di = defenders.length; di < desired; di++) {
					prio = Math.min(PRIORITY_MED, Math.ceil(100 * (di / desired)));
					const supplier = _.sample(['requestDefender', 'requestRanger']);
					Unit[supplier](spawn, roomName, prio);
				}
				if (this.room.hostiles.length && _.all(this.room.hostiles, 'owner.username', INVADER_USERNAME)) {
					this.evacuate(`Game.rooms['${this.pos.roomName}'].hostiles.length <= 0`);
					Log.warn(`Failure to handle invaders cleanly. Evacuating ${this.pos.roomName}.`, 'Controller');
					_.invoke(this.room.structuresByType[STRUCTURE_RAMPART], 'setPublic', true);
					const RELOCK_DELAY = 60; // Need time to get everybody out of the room.
					this.memory.relock = Game.time + RELOCK_DELAY;
				}
			}
		}

		// Healers
		// @todo Disabled until we can prevent these spawning for injured creeps in other rooms.
		if (healers.length < 1 && _.any(creeps, c => c.hits < c.hitsMax)) {
			Unit.requestHealer(spawn, roomName);
		}

		// beyond this point, room-local spawns only
		if (roomName !== this.pos.roomName)
			return;

		if (ENV('empire.scout', true) && !scouts.length) {
			Unit.requestScout(spawn, { origin: this.pos.roomName }, 25);
		}

		const maxScav = (this.level < 3) ? 6 : 4;
		let scavNeed = CLAMP(2, resDecay, maxScav);
		const scavHave = scav.length;
		// @todo: Every tick we can pretty easily get this value. Can we do anything useful with it?
		if (this.room.energyPct < 0.25)
			scavNeed += 1;
		const ownedStructures = this.room.structuresMy;
		// if(scavHave < scavNeed && _.size(this.room.structures) > 1) {
		// console.log(`scav ${scavHave} / ${scavNeed}`);
		if (_.size(ownedStructures) <= 1)
			scavNeed = 1;
		if (scavHave < scavNeed) {
			if (scavHave === 0 && pilot.length <= 0) {
				Log.warn(`${this.pos.roomName} No scavs, creating pilot`, 'Controller');
				Unit.requestPilot(spawn, roomName);
				return;
			}
			// prio = 100 - Math.ceil(100 * (scavHave / scavNeed));
			prio = CLAMP(0, Math.ceil(100 * (scavHave / scavNeed)), 75);
			if (scavHave <= 0 && assistingSpawn)
				spawn = assistingSpawn;
			// Log.warn("Short on scavengers at " + this.pos.roomName + ' (prio: ' + prio + ')');		
			// Log.warn(`Requesting scavenger to ${this.pos.roomName} from ${spawn.pos.roomName} priority ${prio}`);
			// function(spawn, home=null, canRenew=true, priority=50, hasRoad=true)
			Unit.requestScav(spawn, roomName, (scavNeed <= 3), prio, (this.level > 2 && roomName === spawn.pos.roomName));
		}

		// const desiredRepair = (this.level >= 4 && (storedEnergy > 200000 || terminalEnergy > 60000)) ? 1 : 0;
		// const desiredRepai
		/**
		 * No repair needed if nothing's damaged
		 * Repair creep will recycle itself.
		 * Shut this off if we're dismantling the room.
		 */
		const currentRepair = _.sum(repair, c => c.getBodyParts(WORK));
		const MAX_REPAIR_CREEPS_PER_ROOM = (this.level >= 3) ? 2 : 1;
		if (repair.length && allotedRepair <= 0) {
			_.invoke(repair, 'setRole', 'recycle');
		} else if (repair.length < MAX_REPAIR_CREEPS_PER_ROOM && currentRepair < allotedRepair) {
			Unit.requestRepair(spawn, roomName, Math.ceil(allotedRepair / MAX_REPAIR_CREEPS_PER_ROOM));
		} else {
			// Excess alloted energy is assigned to upgrade
			allotedUpgrade = Math.min(maxAllotedUpgrade, allotedUpgrade + (allotedRepair - currentRepair));
			allotedRepair = currentRepair;
		}

		// @todo conflict mode reduce this
		// @todo did we beak RCL 8 low power mode?
		// @todo CREEP_SPAWN_TIME * 6 needs a better scale calc
		// @todo if rcl 8 and empire doesn't want to expand, scale back
		const MAX_UPGRADER_COUNT = 6;
		if (!this.upgradeBlocked || this.upgradeBlocked < CREEP_SPAWN_TIME * 6) {
			const workAssigned = _.sum(upgraders, c => c.getBodyParts(WORK)); // @todo does this account for boosts?
			const missingWork = allotedUpgrade - workAssigned;
			const pctWork = _.round(workAssigned / allotedUpgrade, 3);
			// let workDesired = 10 * (numSources / 2);
			// let workDesired = Math.min(Math.floor(allotedUpgrade), CONTROLLER_MAX_UPGRADE_PER_TICK);
			if (this.level === MAX_ROOM_LEVEL) {
				const GCL_GOAL = 30;
				if (pctWork < 0.25) // && (this.ticksToDowngrade < CONTROLLER_EMERGENCY_THRESHOLD || storedEnergy > 700000 || Game.gcl.level < GCL_GOAL))
					Unit.requestUpgrader(spawn, roomName, pctWork, allotedUpgrade);
			} else {
				Log.debug(`${this.pos.roomName} Upgraders: ${workAssigned} assigned, ${allotedUpgrade} desired, ${missingWork} diff (${pctWork})`, 'Controller');
				// if (pctWork < 0.5 && )
				if (missingWork >= 5 && upgraders.length < MAX_UPGRADER_COUNT) // minimum amount of extra work we could get out of having another creep
					Unit.requestUpgrader(spawn, roomName, pctWork, (allotedUpgrade));
			}
		} else if (this.upgradeBlocked) {
			Log.warn(`${this.pos.roomName} upgrade blocked for ${this.upgradeBlocked} ticks`, 'Controller');
		}

		if (!scientists.length && this.room.terminal && this.room.terminal.isActive()) {
			spawn.submit({
				body: [MOVE, MOVE, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, CARRY, CARRY, CARRY, MOVE],
				memory: { role: 'scientist', home: this.pos.roomName, msg: '' },
				priority: PRIORITY_MED
			});
		}
	} finally {
		const remainder = adjusted - allotedRepair - allotedBuild - allotedUpgrade;
		var report = "";
		report += `\nBase ${_.round(base, 3)} Remote ${_.round(remote, 3)} Reactor ${_.round(reactor, 3)} Over ${_.round(overstock, 3)} Decay: ${enDecay}`;
		report += `\nUpkeep: ${_.round(upkeep, 3)}, Creep: ${_.round(upkeepCreeps, 3)}, Structure: ${_.round(upkeepStructures, 3)}`;
		report += `\nIncome: ${_.round(income, 3)}, Overstock: ${_.round(overstock, 3)}, Expense: ${_.round(expense, 3)}, Upkeep: ${_.round(upkeep, 3)}, Net: ${_.round(net, 3)}, Avail ${_.round(avail, 3)}, Banked: ${storedEnergy}, Adjusted ${_.round(adjusted, 3)}`;
		report += `\nAllotments: ${_.round(allotedUpgrade, 3)} upgrade, ${_.round(allotedRepair, 3)} repair, ${_.round(allotedBuild, 3)} build, ${_.round(remainder, 3)} leftover`;
		Log.info(`<details><summary>Income/Expense Report (${this.pos.roomName})</summary>${report}</details>`);
	}
}

StructureController.prototype.getAssistingSpawn = function () {
	if (!this.memory.retarget || Game.time > this.memory.retarget) {
		Log.debug(`Reset assisting spawn for ${this.pos.roomName}`, 'Controller');
		this.clearTarget();
		this.memory.retarget = Game.time + 10000;
	}
	return this.getTarget(
		() => _.filter(Game.spawns, s => s.pos.roomName !== this.pos.roomName && Game.map.getRoomLinearDistance(s.pos.roomName, this.pos.roomName) <= 2),
		(candidate) => candidate.room.energyCapacityAvailable > this.room.energyCapacityAvailable && !candidate.isDefunct(),
		(candidates) => this.pos.findClosestByPathFinder(candidates, (c) => ({ pos: c.pos, range: 1 })).goal
	);
};

/**
 * Push a flee state for all creeps
 * @param {String|Number} condition - Tick to end wait, or eval condition
 */
StructureController.prototype.evacuate = function (condition) {
	this.room.find(FIND_MY_CREEPS).forEach(c => {
		c.pushStates([
			['Wait', condition],
			['FleeRoom', { room: this.pos.roomName }]
		]);
	});
};

/**
 * Safe mode automation
 */
StructureController.prototype.updateSafeMode = function () {
	try {
		if (this.safeModeCooldown === SAFE_MODE_LOW_COOLDOWN)
			Log.notify(`${this.pos.roomName}: Safe mode cooldown almost complete`);
		if (this.safeMode > this.memory.safeMode)
			this.onSafeModeEnter();
		else if (this.safeMode == null && this.memory.safeMode)
			this.onSafeModeExit();
		if (this.safeMode === SAFE_MODE_LOW_TICKS)
			Log.notify(`${this.room.name}: Safe mode expiring soon!`);
		if (this.ticksToDowngrade === EMERGENCY_NOTIFICATION_THRESHOLD[this.level])
			Log.warn(`${this.pos.roomName}: Low ticksToDowngrade, Safe mode at risk`, 'Controller');
		else if (this.ticksToDowngrade > EMERGENCY_NOTIFICATION_THRESHOLD[this.level] && this.memory.ticksToDowngrade <= EMERGENCY_NOTIFICATION_THRESHOLD[this.level] && !this.safeModeCooldown) {
			Log.warn(`${this.pos.roomName}: Safe mode unblocked`, 'Controller');
		}

		if (Game.time === this.memory.postNukeSafeMode) {
			Log.notify(`${this.pos.roomName} Activating post-nuke safe mode.`);
			this.activateSafeMode();
		}
	} finally {
		this.memory.safeMode = this.safeMode || 0;
		this.memory.ticksToDowngrade = this.ticksToDowngrade || 0;
	}
};

StructureController.prototype.onSafeModeEnter = function () {
	Log.notify(`Room ${this.room.name} entering safe mode at ${DATE_FORMATTER.format(Date.now())}!`);
};

StructureController.prototype.onSafeModeExit = function () {
	Log.notify(`Room ${this.room.name} leaving safe mode at ${DATE_FORMATTER.format(Date.now())}!`);
};

/** 
 * Controller level automation
 */
StructureController.prototype.updateLevel = function () {
	if (!this.memory.level)
		this.onBootup();
	if (this.level < this.memory.level)
		this.onDowngrade(this.level, this.memory.level);
	if (this.level > this.memory.level)
		this.onUpgrade(this.level, this.memory.level);
	this.memory.level = this.level;
};

/**
 * Controller event for claimed room. One time events? They go here.
 */
StructureController.prototype.onBootup = function () {
	Log.success(`Room ${this.pos.roomName} claimed`, 'Controller');
	this.memory.maxlevel = this.level;
	this.memory.claimedAt = Game.time;
	this.memory.claimedAtTS = Date.now();
	// @todo replace with something smarter, or ensure the room is clear first
	this.room.find(FIND_HOSTILE_STRUCTURES).forEach(s => s.destroy());
};

StructureController.prototype.onDowngrade = function (level, prev) {
	Log.error(`${this.room.name} has downgraded to level ${this.level}`, 'Controller');
};

// 2016-11-06: Now reports remaining safe mode when we reach RCL 3
StructureController.prototype.onUpgrade = function (level, prev) {
	Log.info(`${this.room.name} has been upgraded to level ${this.level}`, 'Controller');

	if (!this.memory.ticksToReach)
		this.memory.ticksToReach = [];
	if (this.memory.ticksToReach[level] == null)
		this.memory.ticksToReach[level] = Game.time - this.memory.claimedAt;

	this.memory.maxlevel = this.level;
	if (this.level === MAX_ROOM_LEVEL) {
		this.memory.rclLastTick = undefined;
		this.memory.rclAvgTick = undefined;
	}

	if (this.level === 3) {
		if (this.safeMode) {
			Log.notify(`RCL 3 reached in ${this.pos.roomName} with ${this.safeMode} ticks left on safe mode!`);
		}
		this.memory['RCL3ReachedIn'] = Game.time - this.memory.claimedAt;
	}

	if (this.level === 2 && !this.safeMode)
		this.activateSafeMode();

	// If build room has nothing to do it uses around 1-3 cpu.
	// If the build queue is full it returns early.
	// So we can call this at a higher frequency.
	// if(Game.time % 300 == 0)
	startProcess('planner', { roomName: this.pos.roomName });
};

/**
 * Progress tracking
 */
StructureController.prototype.updateRclAvg = function () {
	if (this.level === MAX_ROOM_LEVEL)
		return;
	if (this.memory.rclLastTick !== null && this.level <= this.memory.level) {
		var diff = this.progress - this.memory.rclLastTick;
		this.memory.rclAvgTick = MM_AVG(diff, this.memory.rclAvgTick, 1000);
	}
	this.memory.rclLastTick = this.progress;
};

StructureController.prototype.estimateInTicks = function () {
	return Math.ceil((this.progressTotal - this.progress) / this.memory.rclAvgTick);
};

StructureController.prototype.estimate = function () {
	return estimate(this.estimateInTicks());
};

StructureController.prototype.canUnclaim = function () {
	return !PREVENT_UNCLAIM.includes(this.pos.roomName);
};

const { unclaim } = StructureController.prototype;
StructureController.prototype.unclaim = function () {
	if (!this.canUnclaim()) {
		Log.notify(`Unable to unclaim ${this.pos.roomName}`);
		throw new LogicError(`Unable to unclaim ${this.pos.roomName}`);
	}
	return unclaim.call(this);
};

/**
 * If safe mode is activated for *any reason* report it.
 */
const { activateSafeMode } = StructureController.prototype;
StructureController.prototype.activateSafeMode = function () {
	const status = activateSafeMode.call(this);
	if (status !== OK)
		Log.error(`${this.pos.roomName} safe mode activation at ${DATE_FORMATTER.format(Date.now())} status ${status}`);
	return status;
};

/**
 * Override room object get link with a higher default range
 */
StructureController.prototype.getLink = function (range = 3) {
	return RoomObject.prototype.getLink.call(this, range);
};