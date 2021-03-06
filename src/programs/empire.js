/** os.prog.market.js - Market management */
'use strict';

/* global ENV, ENVC, Market */
import { ENV } from '/os/core/macros';
import Process from '/os/core/process';
import * as Intel from '/Intel';
import RouteCache from '/cache/RouteCache';
import { IS_SAME_ROOM_TYPE } from '/os/core/macros';
import { Log, LOG_LEVEL } from '/os/core/Log';

const DEFAULT_EMPIRE_EXPANSION_FREQ = CREEP_CLAIM_LIFE_TIME; // Let's set this to at least higher than a creep life time.

export default class EmpireProc extends Process {
	constructor(opts) {
		super(opts);
		this.priority = Process.PRIORITY_IDLE;
		this.default_thread_prio = Process.PRIORITY_IDLE;
	}

	/* eslint-disable require-yield */
	*run() {
		this.startThread(this.autoExpand, null, Process.PRIORITY_IDLE, `Automatic empire expansion`);
		return false;
	}

	/** Periodically attempts to expand to a new room */
	*autoExpand() {
		while (true) {
			if (!this.memory.nextCheck)
				this.memory.nextCheck = Game.time - 1;
			if (Game.time < this.memory.nextCheck)
				yield this.sleepThread(this.memory.nextCheck - Game.time); // When we unpause, we'll be right on schedule
			this.memory.nextCheck = Game.time + ENV('empire.expansion_freq', DEFAULT_EMPIRE_EXPANSION_FREQ);
			if (ENV('empire.auto_expand', true) === false)
				continue; // Don't exit, we might change our minds.
			if (_.sum(Game.rooms, "my") >= Game.gcl.level)
				continue;// Nothing to do.
			yield this.startThread(this.expand, null, Process.PRIORITY_CRITICAL, `Claiming room`);
			// @todo check if we succeeded
		}
	}

	/** Actually expands to a new room (Kept separte for manual intervention) */
	*expand() {
		if (_.sum(Game.rooms, "my") >= Game.gcl.level)
			throw new Error(`Already at room limit`);
		// Pick a room!
		// Verify it isn't owned or reserved. Continue picking.
		// Launch claimer!
		// Or build colonizer to target lock a room. (Except which room spawns him?)
		const body = [MOVE, CLAIM];
		const cost = UNIT_COST(body);
		const spawns = _.reject(Game.spawns, r => r.isDefunct() || r.room.energyCapacityAvailable < cost);
		if (!spawns || !spawns.length)
			return this.error(`No available spawn for expansion on tick ${Game.time}`);

		// @todo check if safe to send a claimer
		const candidates = this.getAllCandidateRoomsByScore().value();
		if (!candidates || !candidates.length)
			return this.error(`No expansion candidates`, 'Empire');
		this.warn(`Candidate rooms: ${candidates}`, 'Empire');
		const [first] = candidates;
		const spawn = _.min(spawns, s => Game.map.findRoute(s.pos.roomName, first).length);
		Log.notify(`Expansion in progress! (Origin: ${spawn.pos.roomName})`);
		return yield spawn.submit({ body: [MOVE, CLAIM], memory: { role: 'pioneer', rooms: candidates }, priority: PRIORITY_MED });
	}

	static cpuAllowsExpansion() {
		// return (Memory.stats["cpu1000"] < Game.cpu.limit - 10);
		const estCpuPerRoom = Memory.stats["cpu1000"] / this.ownedRoomCount();
		Log.debug(`Empire estimated ${estCpuPerRoom} cpu used per room`, 'Empire');
		return (Memory.stats["cpu1000"] + estCpuPerRoom) < Game.cpu.limit - 10;
	}

	// @todo Fuzz factor is still problematic.
	getAllCandidateRoomsByScore(range = ENV('empire.expansion_default_range', 5)) {
		return this
			.getAllCandidateRooms(range)
			// .map(r => ({name: r, score: Intel.scoreRoomForExpansion(r) * (0.1+Math.random() * 0.1)}))
			// .sortByOrder(r => r.score, ['desc'])
			.sortByOrder(r => Intel.scoreRoomForExpansion(r) * (0.1 + Math.random() * 0.1), ['desc'])
		// .sortByOrder(r => Intel.scoreRoomForExpansion(r), ['desc'])
	}

	getAllCandidateRooms(range = 3) {
		const start = _.map(this.ownedRooms(), 'name');
		const seen = _.zipObject(start, Array(start.length).fill(0));
		const q = start;
		const candidates = [];
		for (const roomName of q) {
			const dist = seen[roomName] || 0;
			// console.log(`${roomName} ${dist}`);
			if (dist >= range)
				continue;
			const exits = _.values(Game.map.describeExits(roomName));
			for (const exit of exits) {
				if (!IS_SAME_ROOM_TYPE(roomName, exit))
					continue;
				if (seen[exit] !== undefined && dist + 1 >= seen[exit])
					continue;
				seen[exit] = dist + 1;
				const score = _.sortedIndex(q, exit, i => seen[i]);
				q.splice(score, 0, exit);
				// console.log(`exit score: ${score}`);
			}
			if (Room.getType(roomName) !== 'Room')
				continue;
			if ((Game.rooms[roomName] && Game.rooms[roomName].my) || dist <= 1)
				continue;
			if (!Intel.isRoomClaimable(roomName))
				continue;

			candidates.push(roomName);
		}

		return _(candidates);
	}

	/**
	 * Find expansion candidates.
	 *
	 * Ex: Empire.getCandidateRooms('W7N3')
	 * W5N3,W8N5,W5N2,W7N5,W9N3,W7N1
	 * W7N4,W8N4,W5N3,W5N2,W9N3,W9N2
	 */
	getCandidateRooms(start, range = 2) {
		const seen = { [start]: 0 };
		const q = [start];
		const candidates = [];
		for (const roomName of q) {
			const dist = seen[roomName];
			if (dist >= range)
				continue;
			const exits = _.values(Game.map.describeExits(roomName));
			for (const exit of exits) {
				if (!IS_SAME_ROOM_TYPE(roomName, exit) || seen[exit] !== undefined)
					continue;
				seen[exit] = dist + 1;
				q.push(exit);
			}
			if (Room.getType(roomName) !== 'Room')
				continue;
			if (Game.rooms[roomName] && Game.rooms[roomName].my)
				continue;
			if (!_.inRange(RouteCache.findRoute(start, roomName).length, 2, 5))
				continue;
			candidates.push(roomName);
		}

		return candidates;
	}


	ownedRooms() {
		return _.filter(Game.rooms, "my");
	}
}