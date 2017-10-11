/**
 * role-builder.js
 *
 * @todo: Add mining state for this creep
 */
"use strict";
var ignoreCreeps = false;

/**
 * Average cpu
 * @todo: do we want to to a max carry / dist deal?
 */
const BUILDER_MAX_FORTIFY_HITS = 10000;


const STATE_GATHER = 'g';
const STATE_UNLOAD = 'u';
const STATE_HARVEST = 'h';
const STATE_FORTIFY = 'f';
const STATE_DEFAULT = STATE_GATHER;

module.exports = {
	// Called once on new creep.
	init: function (creep) {
		this.memory.ignoreRoads = (creep.plainSpeed === creep.roadSpeed);
	},
	// Called to calculate body
	body: function (energyCapacity, energyAvailable, room, spawn) {

	},
	// Role function
	run: function run(creep) {
		var state = creep.getState(STATE_DEFAULT);
		if (creep.carry[RESOURCE_ENERGY] >= creep.carryCapacity)
			creep.setState(STATE_UNLOAD);
		else if (creep.carry[RESOURCE_ENERGY] === 0 && state !== STATE_HARVEST && state !== STATE_GATHER)
			creep.setState(STATE_GATHER);
		state = creep.getState(STATE_DEFAULT);
		if (state === STATE_GATHER) {
			if(creep.gatherEnergy() === ERR_INVALID_TARGET)
				this.setState(STATE_HARVEST);
		} else if(state === STATE_HARVEST) {
			const source = this.getTarget(
				({ room }) => room.find(FIND_SOURCES_ACTIVE),
				(s) => (s instanceof Source) && (s.energy > 0 || s.ticksToRegeneration < this.pos.getRangeTo(s)),
				(sources) => this.pos.findClosestByPath(sources)
			);
			creep.harvestOrMove(source);
		} else if (state === STATE_FORTIFY) {
			var structs = _.map(this.lookForNear(LOOK_STRUCTURES, true, 3), LOOK_STRUCTURES);
			structs = _.filter(structs, s => s.hits < s.hitsMax && s.hits < BUILDER_MAX_FORTIFY_HITS);
			if(_.isEmpty(structs)) {
				this.setState(STATE_UNLOAD);
				return;
			}
			var target = _.min(structs, 'hits');
			this.repair(target);
		} else {
			if (this.pos.hasConstructionSite()) {
				return this.move(_.random(0, 8));
			}
			const site = creep.getTarget(
				({ room }) => room.find(FIND_MY_CONSTRUCTION_SITES),
				(s) => s instanceof ConstructionSite,
				(sites) => _.max(sites, s => (STRUCTURE_BUILD_PRIORITY[s.structureType] || 1) / creep.pos.getRangeTo(s))
			);
			if (site) {
				var status;
				if ((status = creep.build(site)) === ERR_NOT_IN_RANGE)
					creep.moveTo(site, {
						reusePath: 5,
						ignoreRoads: this.memory.ignoreRoads || true,
						ignoreCreeps: ((creep.memory.stuck < 3) ? ignoreCreeps : false),
						range: CREEP_BUILD_RANGE,
						maxRooms: 1
						// ignoreCreeps: false
					});
				else if (status !== OK) {
					console.log(`build status: ${status} for ${this.name} at ${this.pos}`);
					this.defer(15);
				} else if (site.structureType === STRUCTURE_RAMPART || site.structureType === STRUCTURE_WALL) {
					this.say('Fortify!');
					this.setState(STATE_FORTIFY);
				}
			} else if (this.room.isBuildQueueEmpty()) {
				creep.setRole('recycle');
			}
		}
	}

};
