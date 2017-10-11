/**
 * role-scav.js
 */
'use strict';

const STATE_GATHER = 'G';
const STATE_UNLOAD = 'U';
const STATE_SHIP = 'S';		// Straight to the terminal
const STATE_DEFAULT = STATE_GATHER;

/* const TRANSITIONS = [
	['I', () => true, STATE_DEFAULT],
	[STATE_GATHER, (c) => c.carryTotal >= c.carryCapacity, STATE_UNLOAD, (c) => c.clearTarget()],
	[STATE_UNLOAD, (c) => c.carryTotal <= 0, STATE_GATHER, (c) => c.clearTarget()],
	[STATE_GATHER, (c) => c.carryTotal > 0 && c.memory.tid == null, STATE_UNLOAD, (c) => c.say('SAVE')],
	[STATE_UNLOAD, (c) => c.carryTotal / c.carryCapacity < 0.25 && c.memory.tid == null, STATE_GATHER, (c) => c.say('Early')],
	[STATE_UNLOAD, (c) => c.isCarryingNonEnergyResource(), STATE_SHIP]
]; */

const TRANSITIONS = {
	[STATE_GATHER]: [
		[(c) => c.carryTotal >= c.carryCapacity, STATE_UNLOAD, (c) => c.clearTarget()],		
		[(c) => c.carryTotal > 0 && c.memory.tid == null, STATE_UNLOAD, (c) => c.say('SAVE')],
	],
	[STATE_UNLOAD]: [
		[(c) => c.carryTotal <= 0, STATE_GATHER, (c) => c.clearTarget()],
		[(c) => c.carryTotal / c.carryCapacity < 0.25 && c.memory.tid == null, STATE_GATHER, (c) => c.say('Early')],
		[(c) => c.isCarryingNonEnergyResource(), STATE_SHIP, (c) => c.say('SHIP')]
	],
	[STATE_SHIP]: [
		[(c) => c.carryTotal <= 0, STATE_GATHER]
	]
};

function getAmt(thing) {
	if (typeof thing === 'string')
		thing = Game.getObjectById(thing);
	return thing.storedTotal || thing.amount || thing.energy;
}

const getPickupSiteWithTerminal = createUniqueTargetSelector(
	function ({ room }) {
		if (room.energyAvailable / room.energyCapacityAvailable < 0.5)
			return [...room.containers, ...room.links, room.storage, room.terminal, ...room.resources];
		else
			return [...room.containers, ...room.resources];
	},
	({ room }) => room.find(FIND_MY_CREEPS, { filter: c => c.getRole() === 'scav' && c.memory.tid }).map(c => c.memory.tid),
	t => Filter.canProvideEnergy(t, TERMINAL_MIN_ENERGY) || Filter.droppedResources(t) || ((t instanceof StructureContainer) && t.storedTotal > 100),
	(candidates, creep) => _.max(candidates, t => Math.min(getAmt(t), creep.carryCapacityAvailable) / creep.pos.getRangeTo(t.pos))
);

const getPickupSite = createUniqueTargetSelector(
	({ room }) => [...room.structures, ...room.resources],
	({ room }) => room.find(FIND_MY_CREEPS, { filter: c => c.getRole() === 'scav' && c.memory.tid }).map(c => c.memory.tid),
	(s, creep) => {
		if (creep.room.energyPct > 0.5 && (s.structureType === STRUCTURE_LINK || s.structureType === STRUCTURE_STORAGE))
			return false;
		return Filter.canProvideEnergy(s);
	},
	(candidates, creep) => _.max(candidates, t => Math.min(getAmt(t), creep.carryCapacityAvailable) / creep.pos.getRangeTo(t.pos))
);

const getDropoffSite = createUniqueTargetSelector(
	({ room }) => _.filter([...room.structuresMy, ...room.creeps], function (sel) {
		if (Filter.canReceiveEnergy(sel) <= 0)
			return false;
		if (sel instanceof Creep) {
			return ['upgrader', 'builder', 'repair'].includes(sel.getRole());
		} else if (sel instanceof StructureLink)
			return false;
		if (sel.store != null)
			return false;
		return true;
	}),
	({ room }) => room.find(FIND_MY_CREEPS, { filter: c => c.getRole() === 'scav' && c.memory.tid }).map(c => c.memory.tid),
	(c,creep) => Filter.canReceiveEnergy(c) && c.pos.roomName === creep.pos.roomName && c.id !== creep.memory.avoid, // currently don't fill stores this way
	(candidates,creep) => _.min(candidates, s => (1 + Filter.canReceiveEnergy(s)) * s.pos.getRangeTo(creep.pos))
);

module.exports = {
	init: function (creep) {
		
	},
	body: function () {

	},
	run: function () {
		var goal;
		if (this.memory.stuck > 15) {
			this.wander();
			return;
		}		
		if(this.hitPct < 0.50) {
			this.pushState('HealSelf');
			return;
		}
		const state = this.transitions(TRANSITIONS, STATE_DEFAULT);
		const { terminal, storage, controller } = this.room;
		if (state === STATE_GATHER) {
			// const goal = module.exports.getPickupSite.call(this);
			goal = (terminal) ? getPickupSiteWithTerminal(this) : getPickupSite(this);
			if (!goal)
				return;
			// let status = this.withdraw(goal, RESOURCE_ENERGY);
			let status = OK;
			if (goal instanceof Resource)
				status = this.pickup(goal);
			else if (goal instanceof StructureTerminal)
				status = this.withdraw(goal, RESOURCE_ENERGY);
			else
				status = this.withdrawAny(goal);
			if (status === ERR_NOT_IN_RANGE)
				this.moveTo(goal, {
					range: 1,
					ignoreRoads: (this.carryTotal <= (this.carryCapacity / 2)),
					ignoreCreeps: this.memory.stuck < 3,
					maxRooms: 1,
					costCallback: r => LOGISTICS_MATRIX[r]
				});
			else if (status !== OK) {
				Log.error(`${this.name} unable to collect from ${goal}, status ${status}`, 'Creep');
			} else {
				this.memory.avoid = goal.id;
			}
		} else if (state === STATE_UNLOAD) {
			if (this.room.controller.isEmergencyModeActive() && !this.room.controller.upgradeBlocked && this.carry[RESOURCE_ENERGY] > 0) {
				goal = this.room.controller;
			} else {
				goal = getDropoffSite(this);
				if (!goal) {
					if (terminal && terminal.my && (terminal.store[RESOURCE_ENERGY] < TERMINAL_MIN_ENERGY * 2 || (storage && storage.stock >= 1)))
						goal = terminal;
					else if (storage && storage.my && (storage.store[RESOURCE_ENERGY] / storage.storeCapacity < 0.9))
						goal = storage;
					else
						goal = controller;
					this.setTarget(goal);
				}
			}
			if (!goal && this.carry[RESOURCE_ENERGY] > 0)
				goal = terminal || storage || controller; // 1 work part and high carry means ~800 ticks of sitting around upgrading.
			let status = OK;
			if (goal instanceof StructureTerminal)
				status = this.transferAny(goal);
			else
				status = this.transfer(goal, RESOURCE_ENERGY);
			if (status === ERR_NOT_IN_RANGE) {
				this.moveTo(goal, {
					range: (goal instanceof StructureController) ? CREEP_UPGRADE_RANGE : 1,
					ignoreRoads: (this.carryTotal <= (this.carryCapacity / 2)),
					ignoreCreeps: this.memory.stuck < 3,
					maxRooms: 1,
					costCallback: r => LOGISTICS_MATRIX[r]
				});
			} else if (status === ERR_FULL) {
				this.say('full!');
				Log.error(`${this.name} got ERR_FULL on ${goal}, suggesting targeting problem`, 'Creep');
				this.clearTarget();
			} else if (status !== OK)
				Log.error(`${this.name} ext-fill: status: ${status} on ${goal} at ${this.pos}`, 'Creep');
		} else if (state === STATE_SHIP) {
			if (this.transferAny(this.room.terminal) === ERR_NOT_IN_RANGE)
				this.moveTo(goal, {
					range: 1,
					ignoreRoads: (this.carryTotal <= (this.carryCapacity / 2)),
					ignoreCreeps: this.memory.stuck < 3,
					maxRooms: 1,
					costCallback: r => LOGISTICS_MATRIX[r]
				});
		}
	}	
};