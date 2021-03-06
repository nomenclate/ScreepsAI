/** /ds/costmatrix.room.js - Cost matrix extensions for specific rooms */
'use strict';

/* global CLAMP */

import { isObstacle } from '/lib/filter';
import CostMatrix from '../CostMatrix';

export const TILE_UNWALKABLE = 255;
export const DEFAULT_ROAD_SCORE = 2; /** Set slightly higher than plainCost to avoid road wear and tear */

/**
 * Base class with functional extensions
 */
export default class RoomCostMatrix extends CostMatrix {
	/** @inherits static deserialize */
	/** @inherits serialize */

	constructor(roomName) {
		super();
		if (_.isEmpty(roomName))
			throw new TypeError(`Expected room name, got ${roomName}`);
		this.roomName = roomName;
	}

	get room() {
		return Game.rooms[this.roomName];
	}

	addConstructionPlan() {
		const { bq } = Memory.rooms[this.roomName] || {};
		if (!bq || !bq.length)
			return;
		for (const itm of bq) {
			if (OBSTACLE_OBJECT_TYPES.includes(itm.structureType))
				this.set(itm.x, itm.y, TILE_UNWALKABLE);
			else if (itm.structureType === STRUCTURE_ROAD)
				this.set(itm.x, itm.y, 1);
		}
	}

	setFixedObstacles(room = this.room, score = TILE_UNWALKABLE) {
		for (const { pos } of room.structuresObstacles) {
			this.set(pos.x, pos.y, score);
		}
		return this;
	}

	setSKLairs(room = this.room) {
		if (room.controller)	// Currently no SK in controllable rooms..
			return this;
		// Disable while SK mining, until we find a better way.
		// @todo shoud this be FIND_HOSTILE_STRUCTURES?
		const KEEPER_RADIUS = 6;
		const LAIR_WEIGHT = 20;
		for (const lair of (room.structuresByType[STRUCTURE_KEEPER_LAIR] || [])) {
			this.applyInRoomRadius((x, y) => this.set(x, y, LAIR_WEIGHT), lair.pos, KEEPER_RADIUS);
		}
		return this;
	}

	// Construction sites? ramparts?
	setDynamicObstacles(room = this.room, score = TILE_UNWALKABLE) {		
		room
			.find(FIND_HOSTILE_CONSTRUCTION_SITES, { filter: c => Player.status(c.owner.username) === PLAYER_ALLY })
			.forEach(s => this.set(s.pos.x, s.pos.y, score));
		room
			.find(FIND_MY_CONSTRUCTION_SITES, { filter: c => isObstacle(c) })
			.forEach(s => this.set(s.pos.x, s.pos.y, score));
		return this;
	}

	setStructureType(room = this.room, type, score = 1) {
		for (const { pos } of (room.structuresByType[type] || [])) {
			this.set(pos.x, pos.y, score);
		}
		return this;
	}

	setRoads(room = this.room, score = DEFAULT_ROAD_SCORE) {
		return this.setStructureType(room, STRUCTURE_ROAD, score);
	}

	setTerrainWalls(roomName = this.roomName, score = TILE_UNWALKABLE) {
		const terrain = Game.map.getRoomTerrain(roomName);
		const sources = (this.room && this.room.find(FIND_SOURCES)) || [];
		for (var x = 0; x < 50; x++) {
			for (var y = 0; y < 50; y++) {
				if (!(terrain.get(x, y) & TERRAIN_MASK_WALL))
					continue;
				if (_.any(sources, s => s.pos.isNearTo(x, y)))
					this.set(x,y, TILE_UNWALKABLE);
				else
					this.set(x, y, score);
			}
		}
		return this;
	}

	setCreeps(room = this.room, score = TILE_UNWALKABLE, filter = _.identity, c = FIND_CREEPS) {
		for (const { pos } of room.find(c, { filter })) {
			this.set(pos.x, pos.y, score);
		}
		return this;
	}

	setPortals(room = this.room, score = TILE_UNWALKABLE) {
		if (room.controller)
			return this;
		for (const { pos } of (room.structuresByType[STRUCTURE_PORTAL] || [])) {
			this.set(pos.x, pos.y, score);
		}
		return this;
	}

	setBorder(range = 1, score = TILE_UNWALKABLE) {
		this.iif(
			(x, y) => (x <= range || x >= (49 - range) || y <= range || y >= (49 - range)),
			(x, y) => this.set(x, y, score)
		);
		return this;
	}

	setExitTiles(room = this.room, score = TILE_UNWALKABLE) {
		room.find(FIND_EXIT).forEach(e => this.set(e.x, e.y, score));
		return this;
	}

	clone() {
		const newMatrix = new RoomCostMatrix(this.roomName);
		newMatrix._bits = new Uint8Array(this._bits);
		return newMatrix;
	}
}