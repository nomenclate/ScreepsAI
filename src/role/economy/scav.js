/**
 * role.scav.js
 */
'use strict';

/* global LOGISTICS_MATRIX */

import { canReceiveEnergy, canProvideEnergy, droppedResources } from '/lib/filter';
import { TERMINAL_MINIMUM_ENERGY, TERMINAL_RESOURCE_LIMIT } from '/proto/structure/terminal';
import { LOGISTICS_MATRIX } from '/CostMatrix';
import { Log, LOG_LEVEL } from '/os/core/Log';

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
	[STATE_UNLOAD, (c) => c.store.hasNonEnergyResource(), STATE_SHIP]
]; */

const TRANSITIONS = {
	[STATE_GATHER]: [
		[(c) => c.carryTotal >= c.carryCapacity, STATE_UNLOAD, (c) => c.clearTarget()],
		[(c) => c.carryTotal > 0 && c.memory.tid == null, STATE_UNLOAD, (c) => c.say('SAVE')],
	],
	[STATE_UNLOAD]: [
		[(c) => c.carryTotal <= 0, STATE_GATHER, (c) => c.clearTarget()],
		[(c) => c.carryTotal / c.carryCapacity < 0.25 && c.memory.tid == null, STATE_GATHER, (c) => c.say('Early')],
		[(c) => c.store.hasNonEnergyResource(), STATE_SHIP, (c) => c.say('SHIP')]
	],
	[STATE_SHIP]: [
		[(c) => c.carryTotal <= 0, STATE_GATHER]
	]
};

function getAmt(thing) {
	if (typeof thing === 'string')
		thing = Game.getObjectById(thing);
	// return thing.storedTotal || thing.amount || thing.energy;
	return thing.amount || (thing.store && thing.store.total);
}

const getPickupSiteWithTerminal = createUniqueTargetSelector(
	function ({ room }) {
		var col = [...room.containers, ...room.resources, ...room.tombstones, ...room.ruins];
		// if (room.energyAvailable / room.energyCapacityAvailable < 0.5)
		if (room.avgInNetwork / LINK_CAPACITY > 0.80 || room.energyAvailable / room.energyCapacityAvailable < 0.70)
			col.push(...room.links);
		if (room.energyAvailable / room.energyCapacityAvailable < 0.90)
			col = col.concat([room.storage, room.terminal]);
		if (room.terminal && room.storage && room.terminal.store[RESOURCE_ENERGY] > TERMINAL_RESOURCE_LIMIT && room.storage.stock < 1)
			col.push(room.terminal);
		if (room.terminal && room.terminal.store[RESOURCE_ENERGY] > TERMINAL_RESOURCE_LIMIT * 1.25)
			col.push(room.terminal);
		if (room.storage && room.storage.stock > 1)
			col.push(room.storage);
		return col;
	},
	({ room }) => room.find(FIND_MY_CREEPS, { filter: c => c.getRole() === 'scav' && c.memory.tid }).map(c => c.memory.tid),
	t => (canProvideEnergy(t) || droppedResources(t) || ((t instanceof StructureContainer) && t.storedTotal > 100)) && !t.isControllerContainer,
	(candidates, creep) => _.max(candidates, t => Math.min(getAmt(t), creep.carryCapacityAvailable) / creep.pos.getRangeTo(t.pos))
);

const getPickupSite = createUniqueTargetSelector(
	({ room }) => [...room.structures, ...room.resources, ...room.tombstones, ...room.ruins],
	({ room }) => room.find(FIND_MY_CREEPS, { filter: c => c.getRole() === 'scav' && c.memory.tid }).map(c => c.memory.tid),
	(s, creep) => {
		if (s.structureType === STRUCTURE_STORAGE && s.stock > 1.0)
			return true; // We have more energy than we expect.
		if (creep.room.energyPct > 0.5 && (s.structureType === STRUCTURE_LINK || s.structureType === STRUCTURE_STORAGE))
			return false;
		return canProvideEnergy(s) && (!s.isControllerContainer || s.room.controller.level >= MAX_ROOM_LEVEL);
	},
	(candidates, creep) => _.max(candidates, t => Math.min(getAmt(t), creep.carryCapacityAvailable) / creep.pos.getRangeTo(t.pos))
);

const getDropoffSite = createUniqueTargetSelector(
	({ room }) => _.filter([...room.structuresMy, room.controller.container, ...room.creeps], function (sel) {
		if (sel == null)
			return false;
		if (canReceiveEnergy(sel) <= 0)
			return false;
		if (sel instanceof Creep) {
			return ['upgrader', 'builder', 'repair'].includes(sel.getRole()) && sel.memory.stuck > 2;
		} else if (sel instanceof StructureLink)
			return false;
		else if (sel instanceof StructureNuker && (!room.storage || room.storage.stock < 0.25))
			return false;
		if (sel instanceof StructureTerminal || sel instanceof StructureStorage) // if (sel.store != null)
			return false;
		return true;
	}),
	({ room }) => room.find(FIND_MY_CREEPS, { filter: c => c.getRole() === 'scav' && c.memory.tid }).map(c => c.memory.tid),
	(c, creep) => canReceiveEnergy(c) && c.pos.roomName === creep.pos.roomName && c.id !== creep.memory.avoid, // currently don't fill stores this way
	(candidates, creep) => _.min(candidates, s => (1 + canReceiveEnergy(s)) * s.pos.getRangeTo(creep.pos))
);

export default {
	boosts: [],
	priority: function () {
		// (Optional)
	},
	body: function () {
		// (Optional) Used if no body supplied
		// Expects conditions..
	},
	init: function () {

	},
	/* eslint-disable consistent-return */
	run: function () {
		var goal;
		if (this.memory.stuck > 15) {
			this.wander();
			return;
		}
		if (this.hitPct < 0.50) {
			this.pushState('HealSelf');
			return;
		}
		const state = this.transitions(TRANSITIONS, STATE_DEFAULT);
		const { terminal, storage, controller } = this.room;
		if (state === STATE_GATHER) {
			// const goal = export default.getPickupSite.call(this);
			goal = (terminal && terminal.storedTotal < terminal.storeCapacity) ? getPickupSiteWithTerminal(this) : getPickupSite(this);
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
					costCallback: r => LOGISTICS_MATRIX.get(r)
				});
			else if (status !== OK) {
				Log.error(`${this.name}/${this.pos} unable to collect from ${goal}, status ${status}`, 'Creep');
			} else {
				this.memory.avoid = goal.id;
			}
		} else if (state === STATE_UNLOAD) {
			if (controller.isEmergencyModeActive() && !controller.upgradeBlocked && this.carry[RESOURCE_ENERGY] > 0 && !controller.assisted) {
				goal = this.room.controller;
				controller.assisted = this.id;
			} else {
				goal = getDropoffSite(this);
				const MAX_OVERSTOCK = 1.5;
				if (!goal) {
					if (storage && storage.my && storage.stock < 1.0 && storage.isActive())
						goal = storage;
					else if (controller.container && controller.container.storedPct < 1.0 && controller.level < MAX_ROOM_LEVEL)
						goal = controller.container;
					else if (terminal && terminal.my
						&& (terminal.store[RESOURCE_ENERGY] < TERMINAL_RESOURCE_LIMIT * MAX_OVERSTOCK) // || (storage && storage.stock >= 1))
						&& terminal.storedTotal < terminal.storeCapacity)
						goal = terminal;
					else if (storage && storage.my && storage.storedPct < 0.9 && storage.stock < MAX_OVERSTOCK && storage.isActive())
						goal = storage;
					else
						goal = controller;
					// Log.warn(`Failover target ${goal}`);
					this.setTarget(goal);
				}
			}
			/* if (!goal && this.carry[RESOURCE_ENERGY] > 0) {
				goal = terminal || storage || controller; // 1 work part and high carry means ~800 ticks of sitting around upgrading.
				Log.warn(`Still no goal set`);
			} */
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
					allowIncomplete: true,
					costCallback: r => LOGISTICS_MATRIX.get(r)
				});
			} else if (status === ERR_FULL) {
				this.say('full!');
				Log.error(`${this.name}/${this.pos} got ERR_FULL on ${goal}, suggesting targeting problem`, 'Creep');
				this.clearTarget();
			} else if (status !== OK)
				Log.error(`${this.name}/${this.pos} ext/fill failed with status: ${status} on ${goal}`, 'Creep');
		} else if (state === STATE_SHIP) {
			if (this.transferAny(this.room.terminal) === ERR_NOT_IN_RANGE)
				this.moveTo(this.room.terminal, {
					range: 1,
					ignoreRoads: (this.carryTotal <= (this.carryCapacity / 2)),
					ignoreCreeps: this.memory.stuck < 3,
					maxRooms: 1,
					costCallback: r => LOGISTICS_MATRIX.get(r)
				});
		}
	}
};