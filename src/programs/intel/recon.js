/** os.prog.recon.js - acquires room visibility */
'use strict';

/* global ENVC */

import * as Co from '/os/core/co';
import Process from '/os/core/process';
import ITO from '/os/core/ito';
import { ENVC } from '/os/core/macros';
import Future from '/os/core/future';
import { TimeLimitExceeded, ActorHasCeased } from '/os/core/errors';

export const DEFAULT_RECON_TIMEOUT = 1000;

/**
 * @todo request power creep observer boost if available (any observer would work)
 */
export default class Recon extends Process {
	constructor(opts) {
		super(opts);
		this.title = 'Services visibility requests';
		this.priority = Process.PRIORITY_HIGH;
		this.default_thread_prio = Process.PRIORITY_HIGH;

		this.observers = [];
		this.scouts = [];

		this.vision_callbacks = {};
		this.vision_requests = [];
	}

	/**
	 * Request vision on a room
	 * 
	 * @todo validate that it's a real, valid room name
	 * 
	 * @param {*} roomName 
	 * @param {*} timeout - How long we have to start the request before failing
	 */
	request(roomName, timeout = ENVC('recon.timeout', DEFAULT_RECON_TIMEOUT, 0), allowScouts = true) {
		if (Game.rooms[roomName])
			return Future.resolve(Game.rooms[roomName]);
		const future = new Future();
		if (!this.vision_callbacks[roomName]) {
			this.vision_callbacks[roomName] = [];
			this.vision_requests.push([roomName, Game.time + timeout, allowScouts]);
		}
		this.vision_callbacks[roomName].push(future);
		return future;
	}

	/**
	 * Purge a vision request and reject any pending futures
	 * 
	 * @param {*} roomName 
	 * @param {*} err 
	 */
	purge(roomName, err) {
		const cbs = this.vision_callbacks[roomName];
		this.warn(`Vision request for ${roomName} timed out`);
		try {
			for (const cb of cbs) {
				try {
					cb.throw(err);
				} catch (err) {
					this.error(`Error rejecting future: ${err}`);
					this.error(err.stack);
				}
			}
		} finally {
			delete this.vision_callbacks[roomName];
		}
	}

	/**
	 * @todo considering powercreep infinite-range observer boost
	 */
	*run() {
		this.startThread(this.assetTracking, undefined, undefined, `Asset tracking`);
		this.startThread(this.updater, undefined, undefined, `Visibility updates`);
		while (!(yield false)) {
			for (var i = this.vision_requests.length - 1; i >= 0; i--) { // , yield true) {
				try {
					const [roomName, timeout, allowScouts] = this.vision_requests[i];
					if (Game.rooms[roomName]) {
						this.vision_requests.splice(i, 1);
						continue;
					}
					if (Game.time > timeout) {
						this.vision_requests.splice(i, 1);
						this.purge(roomName, new TimeLimitExceeded(`Vision request ${roomName} timed out`));
						continue;
					}
					const asset = _.find(this.assets, a => (a.lastRoom === roomName || a.memory.nextRoom === roomName) || (a.memory.roomName === roomName && !a.memory.idle));
					if (asset) {
						this.debug(`Duplicate vision request in progress by asset ${asset}/${asset.pos}`);
						this.vision_requests.splice(i, 1);
						continue;
					}
					this.debug(`Finding asset for ${roomName}`);
					const observer = _.find(this.observers, o => !o.memory.nextRoom && Game.map.getRoomLinearDistance(roomName, o.pos.roomName, false) <= o.getRange());
					if (observer) {
						this.info(`Commandeering observer at ${observer.pos.roomName} to inspect ${roomName} on tick ${Game.time}`)
						observer.memory.nextRoom = roomName;
						this.vision_requests.splice(i, 1);
						continue;
					}
					this.debug(`No observer available for ${roomName} on tick ${Game.time}`);
					if (!allowScouts) {
						this.debug(`Not using scouts for ${roomName}`);
						continue;
					}
					// @todo check if they can route to the room
					const scouts = _.filter(this.scouts, c => c.memory.idle !== false && Game.map.getRoomLinearDistance(roomName, c.pos.roomName, false) <= c.ticksToLive / 50);
					if (!scouts || !scouts.length) {
						this.debug(`No idle scouts in range`);
						continue;
					}
					const scout = _.min(scouts, c => Game.map.getRoomLinearDistance(roomName, c.pos.roomName, false));
					if (scout) {
						const range = Game.map.getRoomLinearDistance(roomName, scout.pos.roomName, false);
						this.info(`Commandeering scout at ${scout.pos.roomName} to inspect ${roomName} (range ${range}) on tick ${Game.time}`);
						scout.memory.idle = false;
						scout.memory.roomName = roomName;
						this.vision_requests.splice(i, 1);
						continue; // build a scout
					}
				} catch (e) {
					if (e instanceof ActorHasCeased)
						return this.warn(`Asset has ceased`);
					this.error(e);
					this.error(e.stack);
					yield false;
				}
			}
		}
	}

	/**
 	 * Fulfill pending requests regardless of how the room vision came to be 
 	 */
	*updater() {
		while (!(yield false)) {
			for (const roomName in this.vision_callbacks) {
				const room = Game.rooms[roomName];
				if (!room)
					continue;
				try {
					const callbacks = this.vision_callbacks[roomName];
					this.info(`Fulfilling ${callbacks.length} vision requests for ${roomName} on tick ${Game.time}`);
					callbacks.forEach(f => f.put(room));
					// @todo release any remaining scouts or observers
				} finally {
					delete this.vision_callbacks[roomName];
				}
			}
			const roomCount = Object.keys(this.vision_callbacks).length;
			this.setThreadTitle(`Pending ${roomCount} rooms`);
		}
	}

	/**
	 * Keeps track of available recon assets
	 */
	*assetTracking() {
		while (true) {
			const observers = _.filter(Game.structures, o => o.structureType === STRUCTURE_OBSERVER && o.isActive());
			const scouts = _.filter(Game.creeps, 'memory.role', 'scout');

			this.observers = _.map(observers, o => ITO.make(o.id));
			this.scouts = _.map(scouts, o => ITO.make(o.id));
			this.assets = [...this.observers, ...this.scouts];

			// @todo if we don't have observers, spawn a scout

			this.setThreadTitle(`Tracking ${this.observers.length} observers and ${this.scouts.length} scouts`);
			yield this.sleepThread(ENVC('recon.asset_update', 15, 1));
		}
	}

	/**
	 * Replace radar sweep with room region sweep
	 */
	*sweep() {
		while (true) {

		}
	}

}

global.TEST_RECON = function* (r) {
	const scout = _.find(Game.creeps, 'memory.role', 'scout');
	const room = scout.room;
	const start = Game.time;
	while (Game.creeps[scout.name].pos.roomName === room.name)
		yield; // console.log(`scout: ${room.name} ${scout.pos}`);
	const end = Game.time - start;
	console.log(`Scout left ${room.name} in ${end} ticks`);
	const sources = room.find(FIND_SOURCES);
	console.log(`sources: ${ex(sources)}`);
};