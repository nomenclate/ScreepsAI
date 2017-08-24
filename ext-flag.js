/**
 * ext-flag.js - Point of interest operations
 *
 * @todo: Squad flags? Doubles as memory and flag goals for most stuff.
 */
"use strict";

if (!Memory.flags)
	Memory.flags = {};

/**
 * Flag logic
 * 2016-11-02: secondaryColor white is idle for all primary states (at the moment), so let's optimize
 * 2016-12-14: seperated run and runLogic because try/catch doesn't optimize
 */
Flag.prototype.run = function () {
	// if(this.secondaryColor === COLOR_WHITE)
	//	return;

	if (this.isDeferred())
		return;

	if (this.isExpired()) {
		Log.warn(`${this.name} expired!`, "Flag");
		this.remove();
		return;
	}

	this.defer(5); // This is mission critical to keeping cpu handled.

	try {
		this.runLogic();
	} catch (e) {
		Log.error(`Error on ${this.name} at ${this.pos}`, 'Flag');
		Log.error(e.stack, 'Flag');
	}
};

/**
 * If we're going to automate flag placement, we're going to need more than
 * just two colors (10x10=100 combi) to control behavior. So let's create a couple
 * of prototypes to fix this.
 * 
 * example: Game.rooms['W2N7'].createLogicFlagAtXY(38,40,null,COLOR_WHITE,COLOR_WHITE,{expire:'this.room.hostiles.length > 1'})
 */
const { createFlag } = Room.prototype;
Room.prototype.createLogicFlagAtXY = function (x, y, name, color, secondaryColor, memory) {
	const result = createFlag.apply(this, arguments);
	if (typeof result !== 'number')
		Game.flags[result].memory = memory; // Apparently if the call succeeds, we get a flag immediately.	
	return result;
};

Room.prototype.createLogicFlagAtPos = function (pos, name, color, secondaryColor, memory) {
	return this.createLogicFlagAtXY(pos.x, pos.y, name, color, secondaryColor, memory);
};

RoomPosition.prototype.createLogicFlag = function (name, color, secondaryColor, memory) {
	if (!Game.rooms[this.roomName])
		throw new Error("No room visibility");
	return Game.rooms[this.roomName].createLogicFlagAtPos(this, name, color, secondaryColor, memory);
};

/**
 * Puts a flag to sleep for given number of ticks.
 */
Flag.prototype.defer = function (ticks) {
	if (!_.isNumber(ticks))
		throw new Error('Flag.defer expects numbers');
	if (ticks <= 0)
		return 0;
	if (ticks >= Game.time)
		Log.notify(`Flag ${this.name} at ${this.pos} deferring for unusually high ticks`);
	this.memory.defer = Math.ceil(Game.time + ticks);
	return this.memory.defer;
};

/**
 * Check if the flag is set to sleep, and clean up the memory if need be.
 */
Flag.prototype.isDeferred = function () {
	var memory = Memory.flags[this.name];
	if (memory !== undefined && memory.defer !== undefined && Game.time < memory.defer)
		return true;
	else if (memory !== undefined && memory.defer)
		delete Memory.flags[this.name].defer;
	return false;
};

Flag.prototype.setSecondaryColor = function (secondaryColor) {
	return this.setColor(this.color, secondaryColor);
};

/**
 * Allows a flag to expire and remove itself.
 */
Flag.prototype.expire = function (until) {
	if (_.isNumber(until))
		this.memory.expire = Math.floor(Game.time + until);
	else
		this.memory.expire = until;
	return this.memory.expire;
};

/**
 * Check if a flag has expired. Unlike isDeferred, does not clean up the memory.
 */
Flag.prototype.isExpired = function () {
	var { expire } = Memory.flags[this.name] || {};
	if (expire == null)
		return false;
	if (typeof expire === 'number') // if(_.isNumber(expire))
		return Game.time >= expire;
	if (_.isString(expire))
		return eval(expire);
	return false;
};

/**
 * Patch to clean up memory when removed
 */
const { remove } = Flag.prototype;
Flag.prototype.remove = function () {
	const status = remove.call(this);
	if (status === OK) {
		Log.info(`Cleaning up memory for ${this.name}`, "Flag");
		delete Memory.flags[this.name];
	}
	return status;
};

Flag.prototype.assignNearbySpot = function (limit = CREEP_LIFE_TIME) {
	const { path, cost } = PathFinder.search(
		this.pos,
		_.map(Game.spawns, s => ({ pos: s.pos, range: 7 }))
	);
	if (cost > limit) {
		Log.warn('cost exceeds limit, no target set', 'Flag');
		return;
	}
	const goal = _.last(path);
	Log.info(`${this.name} assigning ${goal} to dropoff`, 'Flag');
	this.memory.dropoff = goal;
	this.memory.steps = cost;
};

/**
 * Checks if we have a creep assigned to this flag. Utilizes cache.
 */
Flag.prototype.getAssignedUnit = function (fn) {
	// if(!_.isFunction(fn))
	//	throw new Exception('Expected function')
	const name = this.cache.creep;
	let creep = Game.creeps[name];
	if (creep && fn(creep)) {
		// console.log('[Flag] cache hit on ' + this.name);
		Log.debug(`Cache hit on ${this.name}`, "Flag");
		return creep;
	} else {
		Log.debug(`Cache miss on ${this.name}`, "Flag");
		creep = _.find(Game.creeps, fn);
		// console.log('result of find: ' + creep);
		if (creep != null)
			this.cache.creep = creep.name;
		return creep;
	}
};

Flag.prototype.clearAssignedUnit = function () {
	this.cache['creep'] = undefined;
};

Flag.prototype.hasAssignedUnit = function (fn) {
	return this.getAssignedUnit(fn) != null;
};

Flag.prototype.hasPendingUnit = function (job) {
	const spawn = this.getClosestSpawn();
	return spawn.hasJob(job);
};

Flag.prototype.runLogic = function () {
	const Unit = require('Unit');

	if (this.color === FLAG_MILITARY) {
		if (this.secondaryColor === STRATEGY_DEFEND) {
			const unit = this.getAssignedUnit(c => c.getRole() === 'guard' && c.memory.site === this.name);
			if (unit)
				return;
			const spawn = this.getClosestSpawn();
			if (!spawn.hasJob({ memory: { role: 'guard', site: this.name } }) && !spawn.spawning) {
				Log.info('Requesting new guard');
				Unit.requestGuard(spawn, this.name, this.memory.body);
			}
			this.defer(DEFAULT_SPAWN_JOB_EXPIRE);
			return;
		}

		/* similar to guard flag, but summons guard in response to threats */
		if (this.secondaryColor === STRATEGY_RESPOND) {
			if (this.room == null) // We can't see the room, we can't act. Maybe request observer?
				return;
			const hostiles = this.room.hostiles;
			if (_.isEmpty(hostiles))
				return this.defer(_.random(25, 50));
			// @todo: 1 or more, guard body based on enemy body and boost.
			let unit = this.getAssignedUnit(c => c.getRole() === 'guard' && c.memory.site === this.name);
			if (!unit) {
				const spawn = this.getClosestSpawn();
				// @todo: Find correct guard to respond.
				Log.warn(`Requesting guard to ${this.pos}`, "Flag");
				Unit.requestGuard(spawn, this.name, [TOUGH, TOUGH, MOVE, RANGED_ATTACK, MOVE, RANGED_ATTACK, MOVE, MOVE, MOVE, ATTACK, MOVE, ATTACK, MOVE, ATTACK, MOVE, HEAL, MOVE, HEAL]);
				return this.defer(DEFAULT_SPAWN_JOB_EXPIRE);
			}
			return this.defer(15);
		}

		/** place reservers */
		// @todo: sleep until reservation clock will be low.
		if (this.secondaryColor === STRATEGY_RESERVE) {
			if (_.get(Memory.rooms, this.pos.roomName + '.reservation') - Game.time > MINIMUM_RESERVATION)
				return;
			if (this.room && this.room.controller.my) {
				Log.warn('We own the controller in ' + this.pos.roomName + ', going to sleep!');
				return this.defer(this.room.controller.ticksToDowngrade);
			}
			if (this.room && this.room.isOnHighAlert())
				return;
			// let reserver = _.find(Game.creeps, 'memory.site', this.pos);
			// Game.flags['Flag41'].getAssignedUnit('memory.site', Game.flags['Flag41'].pos)		
			// ^ works
			let reserver = this.getAssignedUnit(c => this.pos.isEqualToPlain(c.memory.site));
			// this.getAssignedUnit(c => c.memory.role === 'war-miner' && this.pos.isEqualTo(c.memory.pos) && c.ticksToLive >= 150);
			if (reserver && ((reserver.ticksToLive - _.get(reserver, 'travelTime', 0)) > 50))
				return;
			let spawn = this.getClosestSpawn();
			if (!spawn.hasJob({ memory: { role: 'reserver', site: this.pos } }) && !spawn.spawning) {
				Log.info('Requesting new reserver at ' + spawn);
				Unit.requestReserver(spawn, this.pos);
				this.defer(Time.secondsToTicks(60 * 5));
			} else {
				// Log.info('Reserver pending');
				// this.memory.defer = Game.time + Time.secondsToTicks(60 * 1);
				this.defer(Time.secondsToTicks(60 * 1));
				// this.defer(3);
			}
			return;
		}

		/** maintain scout */
		if (this.secondaryColor === STRATEGY_SCOUT) {
			let unit = this.getAssignedUnit(c => c.getRole() === 'scout' && c.memory.flag === this.name);
			if (unit)
				return;
			let spawn = this.getClosestSpawn();
			if (spawn.hasJob({ memory: { role: 'scout', flag: this.name } }))
				return;
			Log.info('Requesting new scout');
			return Unit.requestScout(spawn, { role: 'scout', flag: this.name });
		}

	}


	/** maintain sk miner */
	if (this.color === FLAG_MINING && this.secondaryColor === SITE_SKMINE) {
		// let miner = _.find(Game.creeps, c => c.memory.role === 'war-miner' && this.pos.isEqualTo(_.create(RoomPosition.prototype, c.memory.pos)) && c.ticksToLive >= 150);
		const miner = this.getAssignedUnit(c => c.getRole() === 'war-miner' && this.pos.isEqualToPlain(c.memory.pos) && c.ticksToLive >= 150);
		// let miner = this.getAssignedUnit(c => c.memory.role === 'war-miner' && this.pos.isEqualTo(c.memory.pos) && c.ticksToLive >= 150);
		const spawn = this.getClosestSpawn();
		if ((!miner || !(miner instanceof Creep)) && !spawn.hasJob({ memory: { role: 'war-miner', pos: this.pos } }) && !spawn.spawning) {
			Log.info('Requesting new war-miner');
			Unit.requestWarMiner(spawn, { role: 'war-miner', pos: this.pos });
			this.defer(Time.secondsToTicks(60 * 15));
		} else {
			this.defer(Time.secondsToTicks(60 * 5));
		}
		return;
	}

	// Commented out for testing.
	/* if(this.color === FLAG_MINING && this.secondaryColor === SITE_DUAL_MINER) {
		// Check for creep first?
		let {spawntime=0,steps} = this.memory;
		let unit = this.getAssignedUnit(c => c.getRole() === 'dualminer' && c.memory.site === this.pos.roomName && (c.ticksToLive > spawntime || c.spawning));
		if(unit) {
			if(unit.spawning)
				return this.defer(50);
			else if( (unit.ticksToLive - spawntime) > 0 )
				return this.defer(Math.min(unit.ticksToLive - spawntime, 50));
		}
		this.clearAssignedUnit();
		let {room,pos} = this;		
		// this.room.isOnHighAlert() disabled because of 1600 tick idle period
		if(!room || !this.room.canMine) // probably bad
			return Log.warn('Dual-miner ' + this.name + ' unable to request unit at this time', 'Flag:unit');
		// Find all sources
		let sources = room.find(FIND_SOURCES);
		if(_.isEmpty(sources)) {
			Log.error('[Flag] No sources to mine in ' + pos.roomName);
			return this.remove();
		} else if(sources.length == 1) {
			Log.warn('[Flag] Dual miner expects multiple sites');
			return;
		}
		
		let totalCapacity = _.sum(sources, 'energyCapacity');
		let [src1,src2] = sources;
		let goal1 = src1.container || src1;
		let goal2 = src2.container || src2;
		if(!steps) {
			steps = goal1.pos.getStepsTo(goal2.pos) * 2; // expecting two sources
			this.memory.steps = steps;
		}
		if(steps == 0) {
			Log.warn('[Flag] Dual miner steps 0?');
			return;
		}		
		let spawn = this.getClosestSpawn();
		var r = Unit.requestDualMiner(spawn, this.pos.roomName, totalCapacity, steps);
		if(r !== false)
			this.memory.spawntime = r;
		return this.defer(Time.secondsToTicks(60 * 5));
	} */

	// Replaced by StructureExtractor run behavior. Might want this back for remote minerals.
	/* if(false && this.color == FLAG_MINING && this.secondaryColor == SITE_MINERAL) {				
		if(!Game.rooms[this.pos.roomName])
			return;
		// if(_.get(Game.rooms[this.pos.roomName], 'controller.my')) // if rcl is too low, defer flag.
		var s = this.pos.lookFor(LOOK_STRUCTURES);
		if(!_.any(s, 'structureType', STRUCTURE_EXTRACTOR)) {
			if(this.room)
				this.room.createConstructionSite(this.pos, STRUCTURE_EXTRACTOR);
			return;
		}

		var mineral = Game.getObjectById(this.name.split('_')[1]);
		if(mineral && mineral.mineralAmount == 0) {
			Log.notify("Mineral site " + this.pos + " empty! deffering operations at this site.");			
			this.memory.defer = Game.time + mineral.ticksToRegeneration;
		} 
		
		var miner = _.find(Game.creeps, c => c.memory.role == 'miner' && c.memory.site == this.name);
		if(miner)
			return;
		
		// var spawn = this.pos.findClosestSpawn();
		let spawn = this.getClosestSpawn();
		Mining.requestMineralMiner(spawn, this.name, 60*5);		
		// Mining.requestRemoteMiner(spawn, this.name, 60*5);
		this.memory.defer = Game.time + Time.secondsToTicks(60 * 5);
			
		return;
	} */

	/**
	 * Remote mining site operations (very similar, but also requires an assigned hauler)
	 * 2016-10-26: carryCapacity gets weird when creeps get damaged
	 */
	if (this.color === FLAG_MINING && this.secondaryColor === SITE_PICKUP && Mining.isRemoteEnabled() && !BUCKET_LIMITER) {
		if (this.room && !this.room.canMine) {
			Log.notify(`[Mining] Cannot mine in ${this.pos.roomName}, deferring.`);
			return this.defer(5000);
		}
		if (!this.memory.dropoff)
			this.assignNearbySpot();
		if (this.room && !BUCKET_LIMITER)
			this.throttle(300, 'clk', () => require('Planner').planRoad(this.pos, { pos: _.create(RoomPosition.prototype, this.memory.dropoff), range: 1 }));
		// Mining.requestRemoteScav(Game.spawns.Spawn2, new RoomPosition(5,13,'E57S46'), null, true)				
		const m = _.matches(this.pos);
		const creeps = _.filter(Game.creeps, c => c.memory.role === 'hauler' && m(c.memory.site));
		const assigned = _.sum(creeps, c => c.getBodyParts(CARRY));
		if (!this.memory.steps)
			this.memory.steps = this.pos.getStepsTo(this.memory.dropoff); // should account for road mixture?
		const {steps,capacity=SOURCE_ENERGY_CAPACITY} = this.memory;
		const estCarry = CARRY_PARTS(capacity, steps);
		const reqCarry = Math.ceil(estCarry + 2); // flat 1 + 2 extra carry
		const remaining = Math.max(0, reqCarry - assigned);
		// Log.info(this.pos + ' assigned: ' + assigned + ', requested: ' + reqCarry + ', remaining: ' + remaining);		
		if (!creeps || remaining > 2) {
			/** high cpu - run sparingly */
			// move out of if, cache steps, reqCarry - sum of carry parts assigned
			Log.info(`New hauler: step count ${steps}, estCarry ${estCarry}, reqCarry ${reqCarry}`, "Flag");
			// let spawn = this.pos.findClosestSpawn();
			const spawn = this.getClosestSpawn();
			Log.success(`Requesting new hauler to site: ${this.pos} from spawn ${spawn}`, "Flag");
			if (!spawn.hasJob({ memory: { role: 'hauler', site: this.pos, dropoff: this.memory.dropoff } }))
				Unit.requestHauler(spawn, { role: 'hauler', site: this.pos, dropoff: this.memory.dropoff }, true, remaining);
			return this.defer(MAX_CREEP_SPAWN_TIME);
		} else if (reqCarry - assigned < 0) {
			Log.warn('[Transport] reporting excess hauler capacity: ' + (reqCarry - assigned) + ' at ' + this.pos);
			// _.invoke(creeps, 'setRole', 'recycle');
		}
		// let creeps = _.filter(Game.creeps, c => c.memory.role == 'scav-remote' && c.memory.site == this.name);

		// wants reservation
		// wants hauler
		return this.defer(Time.secondsToTicks(60 * 1)); // 20 ticks
	}

	/**
	 * Normal mining site operation
	 */
	// Move to module?
	if (this.color === FLAG_MINING
		&& (((this.secondaryColor === SITE_LOCAL || this.secondaryColor === SITE_NEAR_RC))
			|| (Mining.isRemoteEnabled() && this.secondaryColor === SITE_REMOTE && !BUCKET_LIMITER))
	) {
		if (this.room && !this.room.canMine) {
			Log.notify('[Mining] Cannot mine in ' + this.room.name + ', deferring.');
			return this.defer(5000);
		}

		// if(this.secondaryColor === SITE_LOCAL && _.get(this.room, 'controller.my', false) === false) {			
		if (this.secondaryColor === SITE_LOCAL && !this.room.my) {
			Log.warn(`Local mining flag ${this.name} at ${this.pos} not in local room`, 'Flag');
			// return this.defer(30);
		}

		// Needs standardized validator and request methods
		// unitFlag(FLAG_MILITARY, STRATEGY_RESPOND, (c) => true, Unit.requestGuard);

		if (this.secondaryColor === SITE_NEAR_RC) {
			// console.log("Updating RC near site");		
			var unit = _.find(this.room.find(FIND_MY_CREEPS), 'memory.role', 'hapgrader');
			if (!unit)
				console.log("No hapgrader at " + this.pos.roomName + '?');
			if (!unit) {// || (unit && unit.memory.arrival && unit.ticksToLive < unit.memory.arrival) ) {
				// var spawn = this.pos.findClosestByRange(_.map(Game.spawns));
				// let spawn = this.pos.findClosestSpawn();
				const spawn = this.getClosestSpawn();
				console.log("Requesting new unit?");
				if (this.room.energyCapacityAvailable >= 1100) {
					Unit.requestHapgrader(spawn);
					this.memory.defer = Game.time + MAX_CREEP_SPAWN_TIME; // 36 + leeway
					return;
				} else
					Mining.requestMiner(spawn, this.name);
			}
			this.memory.defer = Game.time + 45;
		} else {
			var spawntime = CREEP_SPAWN_TIME * 11;
			var miner = this.getAssignedUnit(c => c.getRole() === 'miner' && c.memory.site === this.name && (c.ticksToLive > spawntime || c.spawning));

			/* var miners = _.filter(Game.creeps, c => c.memory.role === 'miner' && c.memory.site === this.name);
			var miner = _.max(miners, 'ticksToLive');
			if(miners.length > 2)
				Log.notify("[FLAG] I DID IT AGAIN " + this.name);
			if(!miners || miners.length <= 0 || Math.abs(miner) == Infinity)
				miner = null; */

			// travel time needs to be based on creep body on path length
			if ((!miner
				|| (miner.ticksToLive < (UNIT_BUILD_TIME(miner.body) + miner.memory.travelTime)))
			) {
				var spawn = this.getClosestSpawn();
				if (this.secondaryColor === SITE_REMOTE)
					Mining.requestRemoteMiner(spawn, this.pos, 50);
				else
					Mining.requestMiner(spawn, this.pos, 50);
				this.defer(Time.secondsToTicks(60 * 7));
				// } else {
				//	console.log("No visibility in " + this.pos.roomName)
				// }		
			} else {
				return this.defer(Math.min(miner.ticksToLive, 50));
			}
		}
	}

};