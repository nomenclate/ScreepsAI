/** Process.js - The base process definition */
'use strict';

/* global ENV, ENVC, MAKE_CONSTANT, MAKE_CONSTANTS, PROCESS_NAMESPACE, Log */

const { OperationNotPermitted } = require('os.core.errors');

if (!Memory.process) {
	Log.warn(`Initializing process memory space`, 'Memory');
	Memory.process = {};
}

class Process {
	constructor(opts) {
		if (!opts.pid)
			throw new Error("Expected pid");
		MAKE_CONSTANT(this, 'instantiated', Game.time, false);
		MAKE_CONSTANTS(this, opts);
		MAKE_CONSTANT(this, 'friendlyName', this.name.charAt(0).toUpperCase() + this.name.slice(1));
		MAKE_CONSTANT(this, 'born', parseInt(this.pid.toString().split('.')[0], 36));

		if (this.default_thread_prio == null)
			this.default_thread_prio = ENVC('thread.default_priority', Process.PRIORITY_DEFAULT, 0.0, 1.0);
	}

	serialize() {
		return JSON.stringify(this);
	}

	/** Overridable */
	static deserialize(opts) {
		return new this(opts);
	}

	static deserializeByProcessName(opts) {
		const module = require(`${PROCESS_NAMESPACE}${opts.name}`);
		return module.deserialize(opts);
	}

	/**
	 * Inspired by ags131, we're using UIDs for pids
	 */
	static getNextId(prefix = '') {
		Game.vpid = ((Game.vpid == null) ? -1 : Game.vpid) + 1;
		return `${prefix}${Game.time.toString(36)}.${Game.vpid.toString(36)}`.toUpperCase();
	}

	get parent() {
		return global.kernel.process.get(this.ppid) || null;
	}

	get threads() {
		return global.kernel.threadsByProcess.get(this);
	}

	/** Memory */
	get memory() {
		if (!Memory.process[this.pid])
			Memory.process[this.pid] = {};
		return Memory.process[this.pid];
	}

	set memory(v) {
		return (Memory.process[this.pid] = v);
	}

	/** Stats */
	get totalCpu() {
		var total = 0;
		for (const [, thread] of this.threads)
			total += (thread.lastRunCpu || 0);
		return _.round(total, CPU_PRECISION);
	}

	get avgSysCpu() {
		var total = 0;
		for (const [, thread] of this.threads)
			total += (thread.avgSysCpu || 0);
		return _.round(total, CPU_PRECISION);
	}

	get avgUsrCpu() {
		var total = 0;
		for (const [, thread] of this.threads)
			total += (thread.avgUsrCpu || 0);
		return _.round(total, CPU_PRECISION);
	}

	get minCpu() {
		var total = 0;
		for (const [, thread] of this.threads)
			total += (thread.minCpu || 0);
		return _.round(total, CPU_PRECISION);
	}

	get maxCpu() {
		var total = 0;
		for (const [, thread] of this.threads)
			total += (thread.maxCpu || 0);
		return _.round(total, CPU_PRECISION);
	}

	/** Lifecycle */
	onStart() { }
	onExit() { }
	onThreadExit(tid, thread) { }
	onChildExit(pid, process) { }

	onReload() {
		this.startThread(this.run, undefined, undefined, 'Main thread');
	}

	/** Thread management */
	startProcess(name, opts, ppid = this.pid) {
		return global.kernel.startProcess(name, opts, ppid);
	}

	startThread(co, args = [], prio, desc) {
		const thread = co.apply(this, args);
		thread.desc = desc;
		return this.attachThread(thread, prio);
	}

	attachThread(thread, priority = this.default_thread_prio) {
		return global.kernel.attachThread(thread, priority);
	}

	getCurrentThread() {
		const thread = global.kernel.getCurrentThread(); // Should hopefully always be the same one running
		if (thread && thread.pid !== this.pid)
			throw new OperationNotPermitted(`Process ${this.pid} does not have permission to access ${thread.tid} in process ${thread.pid}`)
		return thread;
	}

	sleepThread(ticks) {
		this.getCurrentThread().sleep = Game.time + ticks;
	}

	sleepProcess(ticks) {
		this.sleep = Game.time + ticks;
	}

	/** Logging */
	log(level = Log.LEVEL_WARN, msg) {
		Log.log(level, `${this.pid}/${global.kernel.ctid || '-'} ${msg}`, this.friendlyName);
	}

	debug(msg) { this.log(Log.LEVEL_DEBUG, msg); }
	info(msg) { this.log(Log.LEVEL_INFO, msg); }
	warn(msg) { this.log(Log.LEVEL_WARN, msg); }
	error(msg) { this.log(Log.LEVEL_ERROR, msg); }
	success(msg) { this.log(Log.LEVEL_SUCCESS, msg); }

	toString() {
		return `[Process ${this.pid} ${this.friendlyName}]`;
	}
}

Process.PRIORITY_DEFAULT = ENVC('process.default_priority', 0.5, 0.0, 1.0);
Process.PRIORITY_LOWEST = 1.0;
Process.PRIORITY_HIGHEST = 0.0;

module.exports = Process;
