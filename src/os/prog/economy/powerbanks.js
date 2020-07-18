/**
 *  os.prog.economy.powerbank.js
 */
'use strict';

/* global Log, MAX_CREEP_SPAWN_TIME */

const Process = require('os.core.process');

class PowerbankProc extends Process {
	/** Low priority */
	constructor(opts) {
		super(opts);
		this.priority = Process.PRIORITY_IDLE;
		this.default_thread_prio = Process.PRIORITY_IDLE;
	}

	*run() {
		yield;
		this.startThread(this.locate, null, Process.PRIORITY_IDLE, `Powerbank scanning`);
		this.startThread(this.process, null, Process.PRIORITY_IDLE, `Powerbank processing`);
	}

	/**
	 * Thread to scan highway rooms for powerbanks and mark them for processing
	 */
	*locate() {
		// @todo if we find one, make sure the destination isn't full
		while (true) {
			// this.setThreadTitle(`Scanning room ${roomName}`);
			yield;
		}
	}

	/**
	 * 
	 */
	*process() {
		while (true) {
			yield;
		}
	}
}

module.exports = PowerbankProc;