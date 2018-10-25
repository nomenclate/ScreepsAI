/**
 * ext-creep-actor.js - Creep extensions for intelligent actors
 */
'use strict';

/* global Log, Filter, UNIT_BUILD_TIME, DEFINE_CACHED_GETTER */
/* global LOGISTICS_MATRIX */
/* global CREEP_BUILD_RANGE, CREEP_RANGED_HEAL_RANGE, CREEP_RANGED_ATTACK_RANGE, CREEP_UPGRADE_RANGE, MINIMUM_SAFE_FLEE_DISTANCE */
/* global Player, PLAYER_HOSTILE, PLAYER_ALLY */
/* global TERMINAL_MINIMUM_ENERGY */
/* global Intel */

global.BIT_CREEP_DISABLE_RENEW = (1 << 0);	// Don't renew this creep.
global.BIT_CREEP_IGNORE_ROAD = (1 << 1);	// Ignore roads when pathfinding.

const ON_ERROR_SLEEP_DELAY = 3;
const CREEP_AUTOFLEE_HP = 0.90;		// Run away at 90% hp

DEFINE_CACHED_GETTER(Creep.prototype, 'module', c => require(`role-${c.getRole()}`));

/**
 * Intents are currently 0.2 cpu. With simultaneous action pipelines,
 * a creep can do multiple things in a tick, driving up intent costs.
 * A busy creep might enact anywhere from .2 to .6 cpu per tick regardless
 * of logic and decision making.
 *
 * A creep's cpu cost might be seen as average cpu per tick, or
 * total cpu used for lifetime.
 *
 * A creep's energy cost might be seen as a one time up front payment,
 * or as energy per tick (cost / age). If accounting for age and renewels,
 * cost should be raised when renewed.
 *
 */
// Action stack as array with destructuring:
// let [action,...args] = ;
// this[action].apply(this,args);
// 
// _.map(Game.creeps, 'memory.cpu')
// _.map(Game.creeps, c => _.round(c.memory.cpu,3))
// _.filter(Game.creeps, c => _.round(c.memory.cpu,3) > 0.8)
Creep.prototype.run = function run() {
	// if(this.spawning === true)
	if (this.spawning)
		return;

	// Off because SK miners
	// this.updateHits();
	const { memory } = this;
	if (this.isDeferred()) {
		this.say(memory.defer - Game.time);
		return;
	}

	try {
		if (this.invokeState() === false) {
			// if (this.hitPct < CREEP_AUTOFLEE_HP)
			if (Math.random() > this.hitPct) {
				this.pushState('HealSelf');
				return;
			}
			// Replaced with stack state.
			if (memory.home !== undefined && (this.pos.roomName !== memory.home || this.pos.isOnRoomBorder()))
				this.pushState("MoveToRoom", memory.home);
			else
				this.runRole();
		}
		this.updateStuck();
	} catch (e) {
		// console.log('Exception on creep ' + this.name + ' at ' + this.pos);
		// console.log(e);
		Log.error(`Exception on creep ${this.name} at ${this.pos}: ${e}`, "Creep");
		Log.error(e.stack, "Creep");
		// console.log(e.stack);
		this.say("HELP");
		this.defer(ON_ERROR_SLEEP_DELAY);
		// this.memory.error = { msg: e.toString(), tick: Game.time, stack: e.stack };
	}
};

/**
 * @param String message - String to log out
 * @param Number level - Log level
 */
Creep.prototype.log = function (message, level = Log.LEVEL_WARN) {
	const { x, y, roomName } = this.pos;
	Log.log(level, `${this.name}/[${roomName}-${x}-${y}]: ${message}`, 'Creep');
};

/**
 * Put a creep to sleep for a given number of ticks, shutting off their logic.
 */
Creep.prototype.defer = function (ticks) {
	if (typeof ticks !== "number")
		throw new TypeError("Creep.defer expects numbers");
	if (ticks >= Game.time)
		Log.notify(`Creep ${this.name} at ${this.pos} deferring for unusually high ticks!`);
	this.memory.defer = Game.time + ticks;
};

/**
 * Check if a creep is asleep.
 */
Creep.prototype.isDeferred = function () {
	var memory = Memory.creeps[this.name];
	if (memory !== undefined && memory.defer !== undefined && Game.time < memory.defer)
		return true;
	else if (memory !== undefined && memory.defer)
		Memory.creeps[this.name].defer = undefined;
	return false;
};

/**
 * Can we renew this creep?
 * @todo: (Optional) (Cpu) Remove body part check and just mark roles with claim parts.
 */
var unRenewableRoles = ['recycle', 'filler', 'pilot', 'defender', 'upgrader'];
Creep.prototype.canRenew = function () {
	if (!this.my)
		return false;
	const { eca, home } = this.memory;
	if (eca && home && Game.rooms[home].energyCapacityAvailable > eca)
		return false;
	return this.spawning === false
		&& this.ticksToLive < CREEP_LIFE_TIME - Math.floor(600 / this.body.length) // Don't waste our time
		&& this.ticksToLive > UNIT_BUILD_TIME(this.body)				// Prevent issues with pre-spawning
		&& !unRenewableRoles.includes(this.getRole())				// More time wasting
		&& !this.isBoosted()										// Don't break our boosts
		&& !this.hasBodypart(CLAIM)									// Can't renew claimers
		;
};

Creep.prototype.harvestOrMove = function (target) {
	const status = this.harvest(target);
	if (status === ERR_NOT_IN_RANGE)
		this.moveTo(target, {
			maxRooms: (this.pos.roomName === target.pos.roomName) ? 1 : 16
		});
	return status;
};

Creep.prototype.transferOrMove = function (target, res, amt) {
	// const status = this.transfer.apply(this, arguments);
	const status = this.transfer(target, res, amt);
	if (status === ERR_NOT_IN_RANGE)
		this.moveTo(target, {
			range: (target instanceof StructureController) ? CREEP_UPGRADE_RANGE : 1
		});
	return status;
};

Creep.prototype.updateStuck = function () {
	var { x, y } = this.pos;
	var code = x | y << 6;
	var { lpos, stuck = 0 } = this.memory;
	if (lpos) {
		this.isStuck = this.memory.lpos === code;
		if (this.isStuck)
			stuck++;
		else
			stuck = 0;
	}
	this.memory.stuck = stuck;
	this.memory.lpos = code;
};

/**
 * Move creep in random direction
 * 
 * @todo Ensure random direction isn't an exit tile..
 */
Creep.prototype.wander = function () {
	return this.move(_.random(0, 8));
};

Creep.prototype.runRole = function () {
	var start = Game.cpu.getUsed();
	var roleName = this.getRole();
	if (!roleName)
		return;
	// try {
	var role = require(`role-${roleName}`);
	role.run.call(this);
	var used = Game.cpu.getUsed() - start;
	this.memory.cpu = Math.mmAvg(used, this.memory.cpu, 100);
	Volatile[`role-${roleName}`] = _.round((Volatile[`role-${roleName}`] || 0) + used, 3);
	// console.log(this.name + ' used ' + used + ' cpu');
};

/**
 * @return string
 */
Creep.prototype.getRole = function () {
	// Role in memory is now considered an override. In case of memory problems, role is inherited by name.
	if (Memory.creeps[this.name] && Memory.creeps[this.name].role)
		return Memory.creeps[this.name].role;
	var roleName = _.trimRight(this.name, '0123456789');
	var result = _.attempt(() => require(`role-${roleName}`));
	if (result instanceof Error) {
		Log.warn(`Rolename ${roleName} not valid for creep ${this.name} at ${this.pos}: ${result}`, 'Creep');
		return null;
	}
	Memory.creeps[this.name].role = roleName;
	return roleName;
};

/**
 * @param string
 */
Creep.prototype.setRole = function (role) {
	if (typeof role !== 'string')
		throw new Error('setRole expects string');
	this.memory.role = role;
	this.say(`${role}!`);
};

/**
 * General purpose energy gathering for all roles?
 */
Creep.prototype.gatherEnergy = function () {
	if (this.carryTotal >= this.carryCapacity)
		return ERR_FULL;
	const goal = this.getTarget(
		({ room }) => [...room.structures, ...room.resources],
		(candidate) => Filter.canProvideEnergy(candidate),
		(candidates, { pos }) => pos.findClosestByPath(candidates)
	);
	if (!goal)
		return ERR_INVALID_TARGET;
	const status = this.pull(goal, RESOURCE_ENERGY);
	if (status === ERR_NOT_IN_RANGE)
		this.moveTo(goal, { ignoreCreeps: (this.memory.stuck < 3), maxRooms: 1 });
	return status;
};

Creep.prototype.getRepairTarget = function () {
	return this.getTarget(
		({ room }) => room.find(FIND_STRUCTURES),
		(structure) => structure.hits < structure.hitsMax,
		(candidates) => _.min(candidates, "hits")
	);
};

Creep.prototype.pull = function (target, resource = RESOURCE_ENERGY) {
	var creep = this;
	var result;
	if (target instanceof Structure) {
		result = creep.withdraw(target, resource);
	} else if (target instanceof Creep) {
		result = target.transfer(creep, resource);
	} else if (target instanceof Resource) {
		result = creep.pickup(target);
	} else if (target instanceof Source) {
		result = creep.harvest(target);
	}
	if (result === ERR_INVALID_TARGET) {
		Log.warn(`${creep.name} pull failed. Target: ${target.id} Resource: ${resource}`, 'Creep');
	}
	return result;
};

const { withdraw } = Creep.prototype;
Creep.prototype.withdraw = function (target, resource, amount) {
	if (resource === RESOURCE_ENERGY && target instanceof StructureTerminal) {
		if (target.store[RESOURCE_ENERGY] <= TERMINAL_MINIMUM_ENERGY)
			return ERR_NOT_ENOUGH_RESOURCES;
	}
	var status = withdraw.apply(this, arguments);
	return status;
};

Creep.prototype.withdrawAny = function (target, limit) {
	if (target.store) {
		const resource = _.findKey(target.store);
		return this.withdraw(target, resource, Math.min(target.store[resource], limit));
	} else if (target.energy != null) {
		return this.withdraw(target, RESOURCE_ENERGY, Math.min(target.energy, limit));
	} else
		throw new Error(`${this.name} unable to withdrawAny from ${target}`);
};

Creep.prototype.dropAny = function () {
	var res = _.findKey(this.carry);
	if (res)
		this.drop(res);
	return ERR_NOT_ENOUGH_RESOURCES;
};

/**
 * Traveller
 */
Creep.prototype.isAvoidingRoom = function (roomName) {
	return false;
};

Creep.prototype.prefersRoom = function (roomName) {
	return false;
};

Creep.prototype.routeCallback = function (roomName, fromRoomName) {
	return 1.0;
};

// @return PathFinder.CostMatrix|false
Creep.prototype.getCostMatrix = function (roomName) {
	Log.warn("Requesting cost matrix for " + roomName);
	return false;
};

/**
 * 2016-12-11: Only flee from creeps that are actually a threat to us.
 * 2016-11-02: Reintroduced the arena matrix in a way that makes sense. 
 */
global.ARENA_MATRIX = (new CostMatrix.CostMatrix).setBorder();

const DEFAULT_FLEE_PLAN_AHEAD = 5;
const DEFAULT_FLEE_OPTS = { maxRooms: 3, maxOps: 2500, flee: true, planAhead: DEFAULT_FLEE_PLAN_AHEAD, heuristicWeight: 0.8 };
Creep.prototype.flee = function (min = MINIMUM_SAFE_FLEE_DISTANCE, all = false, opts = {}) {
	if (!min || typeof min !== "number" || min <= 1)
		throw new TypeError(`Unacceptable minimum distance: ${min}, must be postive integer greater than 1`);
	if (this.fatigue)
		return ERR_TIRED;
	// let hostiles = this.pos.findInRange(FIND_HOSTILE_CREEPS, min, {filter: Filter.unauthorizedHostile});
	var hostiles;
	if (all)
		hostiles = this.pos.findInRange(FIND_CREEPS, min - 1, { filter: c => c.id !== this.id });
	else
		hostiles = this.pos.findInRange(this.room.hostiles, min - 1, { filter: Filter.unauthorizedCombatHostile });

	if (hostiles == null || hostiles.length <= 0)
		return ERR_NOT_FOUND;

	_.defaults(opts, DEFAULT_FLEE_OPTS);
	const goals = _.map(hostiles, c => ({ pos: c.pos, range: min + opts.planAhead }));
	// Smarter flee via cost fixing.
	// If we can move equally across both, prefer swamps
	/* if (opts.swampCost == null || opts.plainCost == null) {
		let plainCost = this.plainSpeed;
		const swampCost = this.swampSpeed;
		if (swampCost <= plainCost || _.all(hostiles, h => this.swampSpeed <= h.swampSpeed))
			plainCost = swampCost + 5;
		opts.plainCost = plainCost;
		opts.swampCost = swampCost;
	} */
	if (opts.roomCallback == null)
		opts.roomCallback = (r) => {
			if (Intel.isHostileRoom(r))
				return false;
			return LOGISTICS_MATRIX.get(r);
			// return Game.rooms[r] ? Game.rooms[r].FLEE_MATRIX : ARENA_MATRIX;
		};
	const { path, ops, cost, incomplete } = PathFinder.search(this.pos, goals, opts);
	if (!path || path.length <= 0) {
		this.log(`Unable to flee`, Log.LEVEL_ERROR);
		this.say("EEK!");
		return ERR_NO_PATH;
	}
	// this.log(`flee: incomplete ${incomplete}, ops ${ops}, cost ${cost}`, Log.LEVEL_INFO);
	this.room.visual.poly(path);
	if (this.carry[RESOURCE_ENERGY])
		this.drop(RESOURCE_ENERGY);
	return this.move(this.pos.getDirectionTo(path[0]));
};

/**
 * Used for fleeing and for intercepting.
 */
Creep.prototype.getFleePosition = function (targets, range = CREEP_RANGED_ATTACK_RANGE) {
	if (_.isEmpty(targets))
		return ERR_NO_PATH;
	const { path } = PathFinder.search(this.pos,
		_.map(targets, c => ({ pos: c.pos, range: range })),
		{
			flee: true,
			maxOps: 500,
			maxRooms: 1
		});
	return (path !== undefined && path.length > 0) ? path[0] : ERR_NO_PATH;
};

/**
 * Predictive intercept 
 */
Creep.prototype.intercept = function (target, range = CREEP_RANGED_ATTACK_RANGE) {
	// Log.warn('Intercept in action at ' + this.pos);
	const goals = target.pos.findInRange(FIND_CREEPS, range, { filter: c => c.owner.username !== target.owner.username });
	const pos = target.getFleePosition(goals, range);
	if (pos === ERR_NO_PATH)
		return this.moveTo(target);
	else
		return this.moveTo(pos, { reusePath: 0 });
};

/**
 * Random direction or flee?
 */
Creep.prototype.scatter = function () {
	this.flee(MINIMUM_SAFE_FLEE_DISTANCE, true);
};

Creep.prototype.moveToRoom = function (roomName) {
	return this.moveTo(new RoomPosition(25, 25, roomName), {
		reusePath: 5,
		range: 23,
		ignoreRoads: this.plainSpeed === this.roadSpeed,
		ignoreCreeps: (this.memory.stuck || 0) < 3,
		costCallback: (name, cm) => LOGISTICS_MATRIX.get(name)
	});
};

/**
 * Monkey patch move to set isMoving with direction;
 */
/*
Commented out, not in use.
let move = Creep.prototype.move;
Creep.prototype.move = function(dir) {
	this.isMoving = dir;
	return move.call(this, dir)
}  */

/**
 * Monkey patch dismantle to limit risks
 */
const { dismantle } = Creep.prototype;
Creep.prototype.dismantle = function (target) {
	// Friendly structures don't get attacked.
	if (target instanceof OwnedStructure
		&& !target.my
		&& Player.status(target.owner.username) !== PLAYER_HOSTILE) {
		Log.warn("[WARNING] Won't dismantle friendly structure!", "Creep");
		this.say("NOPE");
		return ERR_INVALID_TARGET;
	}

	if (target.structureType === STRUCTURE_SPAWN && target.my) {
		Log.notify("Money patch prevent spawn disamantle");
		this.say("HELL NO");
		throw new Error("Attempted to dismantle our spawn");
	}

	return dismantle.call(this, target);
};

/**
 * Attack restrictions
 */
const { attack } = Creep.prototype;
Creep.prototype.attack = function (target) {
	// Friendlies are safe.			
	if (target == null || target.my
		|| (target.owner && Player.status(target.owner.username) !== PLAYER_HOSTILE)) {
		return ERR_INVALID_TARGET;
	}
	return attack.call(this, target);
};

const { rangedAttack } = Creep.prototype;
Creep.prototype.rangedAttack = function (target) {
	if (target.my
		|| (target.owner && Player.status(target.owner.username) !== PLAYER_HOSTILE)) {
		return ERR_INVALID_TARGET;
	}
	return rangedAttack.call(this, target);
};

/**
 * Build restrictions
 *
 * Uses 5 energy per work per tick (5 pe/t)
 */
const { build } = Creep.prototype;
Creep.prototype.build = function (target) {
	if (!target
		|| !(target instanceof ConstructionSite)
		|| !target.my && Player.status(target.owner.username) !== PLAYER_ALLY)
		return ERR_INVALID_TARGET;
	const status = build.call(this, target);
	if (status === ERR_INVALID_TARGET && OBSTACLE_OBJECT_TYPES.includes(target.structureType)) {
		const obstruction = target.pos.getCreep();
		if (obstruction)
			return obstruction.scatter();
	}
	return status;
};

/**
 * Heal restrictions
 */
const { heal } = Creep.prototype;
Creep.prototype.heal = function (target) {
	if (target.hits >= target.hitsMax)
		return ERR_FULL;
	if (!target.my && Player.status(target.owner.username) !== PLAYER_ALLY)
		return ERR_INVALID_TARGET;
	const status = heal.call(this, target);
	if (status === OK)
		Object.defineProperty(target, "hits", {
			value: target.hits + (HEAL_POWER * this.getActiveBodyparts(HEAL)),
			configurable: true
		});
	return status;
};

const { rangedHeal } = Creep.prototype;
Creep.prototype.rangedHeal = function (target) {
	if (!target.my && Player.status(target.owner.username) !== PLAYER_ALLY)
		return ERR_INVALID_TARGET;
	return rangedHeal.call(this, target);
};

/**
 * Repair restrictions
 */
const { repair } = Creep.prototype;
Creep.prototype.repair = function (target) {
	if (target.hits >= target.hitsMax)
		return ERR_FULL;
	if (!target || target.owner && !target.my && Player.status(target.owner.username) !== PLAYER_ALLY) {
		Log.warn(`Target ${target} at ${((!target) ? 'null' : target.pos)} invalid ownership, unable to repair`, "Creep");
		return ERR_INVALID_TARGET;
	}
	return repair.call(this, target);
};

/**
 * Globally patch creep actions to log error codes.
 */
/* ['attack','attackController','build','claimController','dismantle','drop',
 'generateSafeMode','harvest','heal','move','moveByPath','moveTo','pickup',
 'rangedAttack','rangedHeal','rangedMassAttack','repair','reserveController',
 'signController','suicide','transfer','upgradeController','withdraw'].forEach(function(method) {
	 let original = Creep.prototype[method];
	 // Magic
	 Creep.prototype[method] = function() {
		 let status = original.apply(this, arguments);
		 if(typeof status === 'number' && status < 0 && status !== ERR_NOT_IN_RANGE) {
			 console.log(`Creep ${this.name} action ${method} failed with status ${status} at ${this.pos}`);
		 }
		 return status;
	 }
 }); */


/**
 * Stack machine actions
 */
/* eslint-disable consistent-return */
Creep.prototype.pushState = function (state, opts = {}, runNext = true) {
	return RoomObject.prototype.pushState.call(this, state, opts, ((this.spawning) ? false : runNext));
};

/**
 * Escape a room, either from a nuke or invasion
 * @todo - Flee hostiles as well
 * @todo - Blocked rooms
 */
Creep.prototype.runFleeRoom = function ({ room, range = 5 }) {
	// Since we can heal and move, try to heal
	this.heal(this);
	const hostiles = _.filter(this.room.hostiles, Filter.unauthorizedCombatHostile);
	const targets = this.pos.findInRange(hostiles, CREEP_RANGED_ATTACK_RANGE);
	if (targets && targets.length && this.hasActiveBodypart(RANGED_ATTACK)) {
		if (targets.length > 1)
			this.rangedMassAttack();
		else
			this.rangedAttack(targets[0]);
	}
	if (this.fatigue > 0)
		return;
	Log.debug(`${this.name} fleeing room ${room}`, 'Creep');
	const pos = new RoomPosition(25, 25, room);
	const goals = _.map(hostiles, c => ({ pos: c.pos, range: CREEP_RANGED_ATTACK_RANGE * 2 }));
	goals.unshift({ pos, range: 25 + range });
	const { path, incomplete } = PathFinder.search(this.pos, goals, {
		flee: true,
		plainCost: this.plainSpeed,
		swampCost: this.swampSpeed,
		maxOps: 8000,
		roomCallback: (r) => (Intel.isHostileRoom(r) ? false : LOGISTICS_MATRIX.get(r))
	});
	if (!path || path.length <= 0 || incomplete) {
		this.popState(false);
	} else {
		this.move(this.pos.getDirectionTo(path[0]));
	}
};

Creep.prototype.runWait = function (opts) {
	RoomObject.prototype.runWait.call(this, opts);
	if (this.hits < this.hitsMax && this.hasActiveBodypart(HEAL))
		this.heal(this);
	this.flee(MINIMUM_SAFE_FLEE_DISTANCE);
};

/**
 * Move to a position and a range
 * @todo - Double check that exit condition
 * @todo - Route
 * @todo - Opts
 */
const MOVE_STATE_FAILED_ATTEMPTS = 5;
Creep.prototype.runMoveTo = function (opts) {
	if (opts.range === undefined)
		opts.range = 1;
	if (opts.ignoreRoads === undefined)
		opts.ignoreRoads = this.plainSpeed === this.roadSpeed;
	// opts.ignoreCreeps = (this.memory.stuck || 0) < 3;
	opts.costCallback = (name, cm) => LOGISTICS_MATRIX.get(name);
	var { pos } = opts;
	var roomPos = _.create(RoomPosition.prototype, pos);
	if (this.pos.inRangeTo(roomPos, opts.range) || opts.failed > MOVE_STATE_FAILED_ATTEMPTS)
		return this.popState();
	const status = this.moveTo(roomPos, opts);
	if (status === ERR_NO_PATH) {
		Log.warn(`${this.name}/${this.pos} aborting pathing attempt to ${roomPos} range ${opts.range}, unable to find path`, 'Creep');
		opts.failed = opts.failed + 1 || 1;
	}
};

Creep.prototype.runMoveToRoom = function (opts) {
	if (this.moveToRoom(opts) === ERR_NO_PATH)
		this.popState();
	if (!opts.evade && !opts.attack)
		return;
	if (!this.room.hostiles || !this.room.hostiles.length)
		return;
	if (opts.evade)
		this.flee(MINIMUM_SAFE_FLEE_DISTANCE);
	else if (opts.attack)
		this.pushState('Combat');
};

Creep.prototype.runAttackMove = function (opts) {
	this.runMoveTo(opts);
	if (this.room.hostiles)
		this.pushState('Combat');
};

Creep.prototype.runEvadeMove = function (opts) {
	if (this.flee(MINIMUM_SAFE_FLEE_DISTANCE) !== OK)
		this.runMoveTo(opts);
};

/**
 * Move between a series of goals. Act accordingly.
 *
 * @todo Respond to hostiles
 * @todo Optional onArrival event
 */
Creep.prototype.runPatrol = function (opts) {
	this.pushState('AttackMove', opts.goals[opts.i]);
	opts.i++;
};

/** ex: goto, claim, recycle */
Creep.prototype.runSetRole = function (opts) {
	this.setRole(opts);
	this.popState();
};

/** ex: goto, runMethod(claim), recycle */
Creep.prototype.runMethod = function (opts) {
	var { method, args } = opts;
	if (this[method].apply(this, args) === OK)
		this.popState();
};

/** Run away and heal */
Creep.prototype.runHealSelf = function (opts) {
	if (this.hits >= this.hitsMax) {
		return this.popState();
	}
	this.heal(this);
	if (this.hasActiveBodypart(HEAL) && this.hitPct > 0.50) {
		if (opts.hits != null) {
			const diff = this.hits - opts.hits;
			opts.hma = Math.mmAvg(diff, opts.hma || 0, 3);
			if (opts.hma < 0 || (-diff / this.hitsMax) > 0.10) {
				this.pushState('FleeRoom', { room: this.room.name });
				opts.hma = 0;
			}
			this.log(`hit move avg: ${opts.hma}`, Log.LEVEL_INFO);
		}
		opts.hits = this.hits;
		this.flee(MINIMUM_SAFE_FLEE_DISTANCE);
		return;
	} else if (this.room.controller && !this.room.controller.my && this.room.controller.owner && Player.status(this.room.controller.owner.username) === PLAYER_HOSTILE) {
		Log.debug(`${this.name}#runHealSelf is fleeing hostile owned room ${this.room.name}`, 'Creep');
		return this.pushState('FleeRoom', { room: this.room.name });
	} else if (this.hitPct < 0.60 && this.room.hostiles && this.room.hostiles.length && _.any(this.room.hostiles, Filter.unauthorizedCombatHostile)) {
		Log.debug(`${this.name}#runHealSelf is fleeing hostile creeps in ${this.room.name}`, 'Creep');
		return this.pushState('FleeRoom', { room: this.room.name });
	}
	if (this.fatigue)
		return;
	// Rather than pushing a state, let's actively adjust for changing targets and current health
	var target = this.getTarget(
		() => _.values(Game.creeps).concat(_.values(Game.structures)),
		(c) => Filter.loadedTower(c) || c.getRole && (c.getRole() === 'healer' || c.getRole() === 'guard') && c.hasActiveBodypart(HEAL),
		(candidates) => {
			var answer = this.pos.findClosestByPathFinder(candidates, (x) => ({
				pos: x.pos, range: (x instanceof StructureTower) ? TOWER_OPTIMAL_RANGE : CREEP_RANGED_HEAL_RANGE
			})).goal;
			Log.debug(`${this.name}#runHealSelf is moving to friendly healer ${answer}`, 'Creep');
			return answer;
		}
	);
	if (!target) {
		// We have a problem.
		Log.debug(`${this.name}#runHealSelf has no target for heal`, 'Creep');
		this.flee(MINIMUM_SAFE_FLEE_DISTANCE);
	} else {
		var range = (target instanceof StructureTower) ? TOWER_OPTIMAL_RANGE : CREEP_RANGED_HEAL_RANGE;
		var status = this.moveTo(target, {
			range,
			plainCost: this.plainSpeed,
			swampCost: this.swampSpeed,
			maxOps: 16000,
			costCallback: (r) => LOGISTICS_MATRIX.get(r)
		});
		if (status !== OK)
			Log.debug(`Moving to target ${target} range ${range}, status ${status}`, 'Creep');
	}
};

/** Tower drain */
Creep.prototype.runBorderHop = function (dest) {
	// If hurt, stop and push heal
	if (this.hits < this.hitsMax || (this.pos.roomName === dest && !this.pos.isOnRoomBorder())) {
		this.pushState('FleeRoom', { room: dest, range: 3 });
		if (this.hasActiveBodypart(HEAL))
			this.heal(this);
		else
			this.pushState('HealSelf');
	} else if (this.pos.roomName !== dest) {
		this.moveToRoom(dest);
	}
};

/**
 * General state for finding energy.
 *
 * If we're not allowed to move, only look for adjacent providers.
 */
Creep.prototype.runAcquireEnergy = function (opts = {}) {
	const { allowMove = false, allowHarvest = true } = opts;
	if (this.carryCapacityAvailable <= 0)
		return this.popState();
	if (this.hits < this.hitsMax)
		this.pushState('HealSelf');	// We can let it continue this tick.
	let target, status;
	if (allowMove) {
		target = this.getTarget(
			({ room }) => [...room.structures, ...room.resources],
			(c) => Filter.canProvideEnergy(c),
			(c) => this.pos.findClosestByPath(c)
		);
	} else {
		target = this.getTarget(
			({ room }) => {
				const resources = _.map(this.lookForNear(LOOK_RESOURCES), LOOK_RESOURCES);
				const structures = _.map(this.lookForNear(LOOK_STRUCTURES), LOOK_STRUCTURES);
				return [...resources, ...structures];
			},
			(c) => Filter.canProvideEnergy(c),
			(c) => this.pos.findClosestByPath(c)
		);
	}
	if (!target && allowHarvest && this.hasBodypart(WORK))
		return this.setState('HarvestEnergy', { allowMove });
	else if (target instanceof Resource)
		status = this.pickup(target);
	else
		status = this.withdraw(target, RESOURCE_ENERGY);
	if (status === ERR_NOT_IN_RANGE && allowMove)
		this.moveTo(target, { range: 1, maxRooms: 1, ignoreRoads: this.memory.ignoreRoad || true });
};

/**
 * Harvest energy to fill ourself up
 */
Creep.prototype.runHarvestEnergy = function ({ allowMove = true }) {
	if (this.carryCapacityAvailable <= 0 || !this.hasBodypart(WORK))
		return this.popState();
	if (this.hits < this.hitsMax)
		this.pushState('HealSelf');	// We can let it continue this tick.
	let source;
	if (allowMove)
		source = this.getTarget(({ room }) => room.find(FIND_SOURCES), s => s.energy > 0, c => this.pos.findClosestByPath(c));
	else
		source = this.getTarget(({ room }) => room.find(FIND_SOURCES), s => s.pos.isNearTo(this));
	if (!source)
		return this.popState();
	const status = this.harvest(source);
	if (status === ERR_NOT_IN_RANGE && allowMove)
		this.moveTo(source, { range: CREEP_HARVEST_RANGE, maxRooms: 1 });
};

/**
 * Find compound
 */
Creep.prototype.runAcquireResource = function () {
	// May use terminal for purchase
};

/**
 * Hunts down a lab with boosts.
 * Can limit amount
 * One boost per state
 * Game.creeps['scav676'].pushState('BoostSelf', {boost:'KO',parts:5})
 * Game.creeps['builder641'].pushState('BoostSelf', {boost:'XLH2O'})
 */
Creep.prototype.runBoostSelf = function ({ boost, parts }) {
	const target = this.getTarget(
		({ room }) => room.structuresByType[STRUCTURE_LAB] || [],
		(lab) => lab.mineralType === boost && lab.mineralAmount >= LAB_BOOST_MINERAL,
		(candidates) => _.min(candidates, c => c.pos.getRangeTo(this)));
	if (!target) {
		this.say("No lab");
		// May acquire resource if has carry part
		// If we have an idle lab, carry, and terminal, go ahead and load it up ourselves
		return this.popState();
	} else if (!this.pos.isNearTo(target))
		return this.moveTo(target, { range: 1 });
	else {
		const sum = _.sum(this.body, p => p.boost === boost);
		const non = _.sum(this.body, p => !p.boost && BOOSTS[p.type] != null && BOOSTS[p.type]['XLH2O'] != null);
		const total = parts ? parts - sum : undefined;
		const cost = non * LAB_BOOST_ENERGY;
		const cpt = cost / CREEP_LIFE_TIME;
		Log.debug(`Boost cost: ${non}/${sum} ${cost} or ${cpt}/t`);
		const status = target.boostCreep(this, total);
		Log.debug(`${this.pos.roomName}/${this.name} boosting result: ${status}`);
		if (sum <= 0 || status !== OK)
			this.popState();
	}
};

/**
 * Build a site at a a position
 */
Creep.prototype.runBuild = function (opts) {
	const roomPos = _.create(RoomPosition.prototype, opts.pos);
	const { allowHarvest = false, allowMove = true } = opts;
	const site = roomPos.getConstructionSite();
	if (!site)
		return this.popState();
	if (this.carry[RESOURCE_ENERGY] <= 0 && this.hasActiveBodypart(CARRY))
		return this.pushState('AcquireEnergy', { allowMove, allowHarvest }, false);
	const status = this.build(site);
	if (status === ERR_NOT_IN_RANGE)
		this.pushState("EvadeMove", { pos: roomPos, range: CREEP_BUILD_RANGE });
	else if (status !== OK)
		Log.warn(`build status: ${status} for ${this.name} at ${this.pos}`);
};

/**
 * Check for a structure or site and attempt to build it.
 * @todo check for construction sites
 * @todo add build state
 */
Creep.prototype.runEnsureStructure = function (opts) {
	const { pos, structureType, range = 0 } = opts;
	const { allowBuild = true, allowHarvest = true, allowMove = true } = opts;
	const roomPos = _.create(RoomPosition.prototype, pos);
	this.popState(false); // Check only needs to happen once.

	if (roomPos.hasStructure(structureType, range)) {
		Log.info(`Creep ${this.name} found ${structureType} at ${roomPos} range ${range}`, 'Creep');
		return;
	} else {
		const site = roomPos.getConstructionSite(structureType, range);
		if (site) {
			Log.info(`Creep ${this.name} found construction site for ${structureType} at ${site.pos}`, 'Creep');
			if (allowBuild && this.hasActiveBodypart(WORK) && this.hasActiveBodypart(CARRY))
				this.pushState('Build', { pos: site.pos, allowHarvest, allowMove }, true);
			return;
		}
	}
	Log.warn(`Creep ${this.name} missed ${structureType} at ${roomPos}`, 'Creep');
	var nPos;
	if (!roomPos.hasObstacle()) {
		nPos = roomPos;
	} else if (this.pos.inRangeTo(roomPos, range)) {
		// @todo check if obstacle or whether one can be placed at our feet.
		nPos = this.pos;
	} else {
		const adjust = OBSTACLE_OBJECT_TYPES.includes(structureType) ? 1 : 0;
		nPos = this.pos.findPositionNear(roomPos, range, {}, adjust);
		Log.info(`Creep ${this.name} requesting nearby position ${roomPos} range ${range}, newPos: ${nPos}`, 'Creep');
	}
	Log.info(`Creep ${this.name} wants to place ${structureType} at ${nPos}`, 'Creep');
	const status = nPos.createConstructionSite(structureType);
	if (status === OK && allowBuild && this.hasActiveBodypart(WORK) && this.hasActiveBodypart(CARRY))
		this.pushState('Build', { pos: nPos, allowHarvest, allowMove }, false);
};

/**
 * 
 */
Creep.prototype.runTransfer = function (opts) {
	const { src, dst = opts.dest, res = RESOURCE_ENERGY, amt = Infinity, srcpos, dstpos } = opts;

	if (amt <= 0)
		this.popState();

	if (this.carryTotal === 0) {
		// Pickup
		const source = Game.getObjectById(src);
		if (source == null)
			return this.popState();
		const wamt = (amt !== Infinity) ? Math.min(amt, this.carryCapacity) : undefined;
		const status = this.withdraw(source, res, wamt);
		if (status === ERR_NOT_IN_RANGE)
			return this.pushState("EvadeMove", { pos: source.pos, range: 1 });
		else if (status === ERR_NOT_ENOUGH_RESOURCES)
			return this.popState();
		else if (status !== OK) {
			Log.warn(`${this.name}/${this.pos}: Failure to withdraw on ${source} status ${status}`, 'Creep');
			this.popState();
		}
	} else {
		const dest = Game.getObjectById(dst);
		const status = this.transfer(dest, res, this.carry[res]);
		if (status === ERR_NOT_IN_RANGE)
			return this.pushState("EvadeMove", { pos: dest.pos, range: 1 });
		else if (status !== OK) {
			Log.warn(`${this.name}/${this.pos}: Failure to transfer on ${dest} status ${status}`, 'Creep');
			this.popState();
		} else
			opts.amt -= this.carry[res];
	}
};