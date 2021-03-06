/**
 * Creates property energyPct on structures, that we can group and sort by
 */
'use strict';

import { Log, LOG_LEVEL } from '/os/core/Log';

/* global DEFINE_CACHED_GETTER, Log, STACK_TRACE */

DEFINE_CACHED_GETTER(Structure.prototype, 'cost', ({ structureType }) => CONSTRUCTION_COST[structureType]);
DEFINE_CACHED_GETTER(Structure.prototype, 'energyPct', s => s.energy / s.energyCapacity);
DEFINE_CACHED_GETTER(Structure.prototype, 'energyCapacityAvailable', s => s.energyCapacity - s.energy);
DEFINE_CACHED_GETTER(Structure.prototype, 'hitPct', s => s.hits / s.hitsMax);
DEFINE_CACHED_GETTER(Structure.prototype, 'storedTotal', s => _.sum(s.store));
DEFINE_CACHED_GETTER(Structure.prototype, 'storedPct', ({ storedTotal, storeCapacity }) => storedTotal / storeCapacity);
DEFINE_CACHED_GETTER(Structure.prototype, 'storageCapacityAvailable', ({ storedTotal, storeCapacity }) => storeCapacity - storedTotal);
DEFINE_CACHED_GETTER(Structure.prototype, 'storedNonEnergyResources', s => s.mineralAmount || (s.store && s.storedTotal - s.store[RESOURCE_ENERGY]) || 0);

DEFINE_CACHED_GETTER(StructureRoad.prototype, 'upkeep', r => ((Game.map.getRoomTerrain(r.pos.roomName).get(r.pos.x, r.pos.y) & TERRAIN_MASK_SWAMP)) ? ROAD_UPKEEP_SWAMP : ROAD_UPKEEP);
DEFINE_CACHED_GETTER(StructureContainer.prototype, 'upkeep', c => c.room.my ? CONTAINER_UPKEEP : REMOTE_CONTAINER_UPKEEP);

/**
 * Monkey patch isActive to cache.
 * @todo: Invalidate periodically?
 */
const { isActive } = Structure.prototype;
Structure.prototype.isActive = function () {
	if (this.cache.active === undefined)
		this.cache.active = isActive.apply(this, arguments);
	return this.cache.active;
};

/**
 * All owned structures can "sleep". But it's up to individual structure logic
 * to decide if it wants to make that check at all.
 */
OwnedStructure.prototype.defer = function (ticks) {
	if (typeof ticks !== 'number')
		throw new TypeError('OwnedStructure.defer expects numbers');
	if (ticks >= Game.time)
		Log.notify(`[WARNING] Structure ${this.id} at ${this.pos} deferring for unusually high ticks! ${STACK_TRACE()}`);
	if (Memory.structures[this.id] === undefined)
		Memory.structures[this.id] = {};
	if (!this.isDeferred())
		this.onDefer(ticks);
	return (Memory.structures[this.id].defer = Game.time + ticks);
};

OwnedStructure.prototype.clearDefer = function () {
	if (Memory.structures[this.id] && Memory.structures[this.id].defer)
		Memory.structures[this.id].defer = undefined;
};

OwnedStructure.prototype.isDeferred = function () {
	if (this.my === true) {
		const memory = Memory.structures[this.id];
		if (memory !== undefined && memory.defer !== undefined && Game.time < memory.defer)
			return true;
		else if (memory !== undefined && memory.defer) {
			Memory.structures[this.id].defer = undefined;
			this.onWake();
		}
	}
	return false;
};

OwnedStructure.prototype.onDefer = function (ticks) {
	// Log.debug(`${this.structureType} ${this.id} going to sleep for ${ticks} at ${Game.time}`, 'OwnedStructure');
};

OwnedStructure.prototype.onWake = function () {
	// Log.debug(`${this.structureType} ${this.id} waking up at tick ${Game.time}`, 'OwnedStructure');
};

/**
 * Provides structure memory.
 */
if (!Memory.structures) {
	Log.warn('Initializing structure memory', 'Memory');
	Memory.structures = {};
}

Object.defineProperty(OwnedStructure.prototype, "memory", {
	get: function () {
		if (!Memory.structures[this.id])
			Memory.structures[this.id] = {};
		return Memory.structures[this.id];
	},
	set: function (v) {
		return _.set(Memory, `structures.${this.id}`, v);
	},
	configurable: true,
	enumerable: false
});