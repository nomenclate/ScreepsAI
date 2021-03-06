/**
 * Algo.js
 *
 * Algorithms for screeps
 */
'use strict';

import { getColorBasedOnPercentage } from '/lib/util';
import Grid from '/ds/Grid';
import Region from '/ds/Region';

/**
 * ES6 Graph class
 * 
 * The relationship between the game and a graph is as follows:
 * Each real position such as a room, a position, or a world coordinate position
 * is a "node" or a "vertex". The _list_ of adjacent positions are the edges.
 * 
 * In the game map, a room is a node and describeExits the edges.
 *
 * Note: A presized array of positions could also work if we had a fixed top left coordinate.
 * 		 Which we don't, outside rooms.
 *
 * See: http://www.redblobgames.com/pathfinding/grids/graphs.html
 */
class Graph {
	constructor() {
		this.nodes = new Grid();
		this.edges = new Grid();
	}

	getNode(x, y) {
		return this.nodes.get(x, y);
	}

	getEdges(x, y) {
		return this.edges.get(x, y);
	}

	/**
	 * Allow prepopulating a grid.
	 */
	setNode(x, y, value) {
		return this.nodes.set(x, y, value);
	}

	setEdges(x, y, edge) {
		return this.edges.set(x, y, value);
	}

	toString() { return "[Graph]"; }
}

/**
 * Base class representing a node or vertex on a graph.
 * This could be a 
 */
class Node {
	constructor(graph, x, y) {
		this.graph = graph; // Graph to refer back to.
		this.x = x;
		this.y = y;
	}

	getNeighbors() {

	}

	toString() { return `[Node ${this.x} ${this.y}]`; }
}

/**
 * 
 */
const TERRAIN_WEIGHT = {
	'plain': 1,
	'swamp': 5,
	'wall': Infinity
};
class RoomPositionNode extends Node {
	constructor(graph, roomPos) {
		super(graph, roomPos.x, roomPos.y);
		this.pos = roomPos;
		this.w = TERRAIN_WEIGHT[Game.map.getTerrainAt(roomPos)];
		// console.log('new node, weight: ' + this.w);
	}

	getNeighbors() {
		// return this.pos.getAdjacentPoints();
		if (!this.n) {
			this.n = _.map(this.pos.getAdjacentPoints(), p => this.graph.getNode(p.x, p.y));
		}
		return this.n;
	}
}

class MapNode extends Node {
	constructor(graph, x, y, name) {
		super(graph, x, y);
		var result = "";
		result += (x < 0 ? "W" + String(~x) : "E" + String(x));
		result += (y < 0 ? "N" + String(~y) : "S" + String(y));
		this.name = result;
	}

	getNeighbors() {
		// var edges = _.values(Game.map.describeExits(this.name));		
		return _(Game.map.describeExits(this.name))
			.map(n => Region.roomNameToCoord(n))
			.map(([x, y]) => ({ x, y }))
			.value();
	}

	toString() {
		return `[MapNode ${this.name} ${this.x} ${this.y}]`;
	}
}

/**
 * Lazy loads nodes and edges on demand.
 */
class LazyGraph extends Graph {
	getNode(x, y) {
		var result = super.getNode(x, y);
		if (result === undefined) {
			result = this.createNode(x, y);
			this.setNode(x, y, result);
		}
		return result;
	}

	getEdges(x, y) {
		var result = super.getEdges(x, y);
		if (result === undefined) {
			var node = this.getNode(x, y);
			result = this.createEdges(x, y, node);
			this.setEdges(x, y, result);
		}
		return result;
	}

	createNode(x, y) { }
	createEdges(x, y, node) { }
}

/**
 * Screeps map-level room coordinates
 */
class MapGraph extends LazyGraph {
	createNode(x, y) {
		return new MapNode(this, x, y);
	}

	createEdges(x, y, node) {
		return node.getNeighbors();
	}
}

/**
 * Screeps room graph 
 */
class RoomGraph extends LazyGraph {
	constructor(roomName) {
		super();
		this.roomName = roomName;
	}

	createNode(x, y) {
		console.log(`Creating node ${x} ${y} ${this.roomName}`);
		return new RoomPositionNode(this, new RoomPosition(x, y, this.roomName));
	}

	createEdges(x, y, node) {
		// return node.getAdjacentPoints(); // Probably filter for reachable?
		return node.getNeighbors();
	}
}

/**
 * Cross between the map level and room level, this graph uses
 * a uniform coordinate system to define a unique postion for every
 * position in every room.
 */
class WorldGraph extends LazyGraph {
	createNode(x, y) {
		return new WorldPosition(x, y);
	}

	createEdges(x, y, node) {
		return node.getAdjacentPoints(); // Probably filter for reachable?
	}
}

function bfs(graph) {

}

/**
 * Depth first search of the graph of choice.
 */
function dfs(node) {
	var ops = 0;
}

/**
 * Flood fill
 *
 * Expands outwards until limit or all reachable locations are visited.
 *
 * https://en.wikipedia.org/wiki/Breadth-first_search
 *
 * @param pos - starting position
 *
 * ex: floodFill(controller.pos)
 * ex: Planner.floodFill(new RoomPosition(46,19,'E58S41'), {limit: 128, validator: (pos) => Game.map.getTerrainAt(pos) !== 'wall' && !pos.hasObstacle()})
 */
function floodFill(pos, {
	validator = ((pos) => Game.map.getTerrainAt(pos) !== 'wall'),
	stop = (p, c) => c > limit,
	limit = 150,
	visualize = true,
} = {}) {
	// var s = new CostMatrix.CostMatrix;
	var visit = new Grid();
	var q = [pos];
	var rtn = [];
	var room = Game.rooms[pos.roomName];
	var count = 0;
	var visual = (room) ? room.visual : (new RoomVisual(pos.roomName));
	var point;
	while ((point = q.shift())) {
		if (stop(point, ++count))
			break;
		rtn.push(point);
		var adj = point.getAdjacentPoints();
		_.each(adj, function (n) {
			if (visit.get(n.x, n.y))
				return;
			visit.set(n.x, n.y, 1);
			if (!validator(n)) {
				if (visualize)
					visual.circle(n, { fill: 'red', opacity: 1.0 });
			} else {
				var color = getColorBasedOnPercentage(100 * (count / limit));
				if (visualize)
					visual.circle(n, { fill: color, opacity: 1.0 });
				// room.visual.circle(n, {fill: 'green'});
				q.push(n);
			}
		});
	}

	console.log('Count: ' + count);
	return rtn;
}
// floodFill: [room W8N2 pos 17,24],[room W8N2 pos 17,23],[room W8N2 pos 18,23],[room W8N2 pos 18,24],[room W8N2 pos 18,25]
// Algo.gFF(new Algo.RoomGraph('W8N2'), 15,24)
// Algo.gFF(new Algo.MapGraph(), -9,-3) // W8N2
// [MapNode W8N2 -9 -3],[MapNode W8N3 -9 -4],[MapNode W7N2 -8 -3],[MapNode W7N3 -8 -4],[MapNode W7N1 -8 -2],[MapNode W7N4 -8 -5],[MapNode W6N3 -7 -4],[MapNode W6N1 -7 -2],[MapNode W6N4 -7 -5],[MapNode W8N4 -9 -5]
// gFF: 
function gFF(graph, x, y, limit = 15) {
	if (x == undefined || y == undefined)
		throw new Error("Missing arguments");
	var q = [{ x, y }];
	var rtn = [];
	var pos, node;
	var count = 0; // ,limit=15;
	while ((pos = q.shift())) {
		node = graph.getNode(pos.x, pos.y);
		if (node.visited)
			continue;
		node.visited = true;
		if (++count > limit)
			break;
		node.getNeighbors().forEach(p => q.push(p));
		rtn.push(node);
	}
	return rtn;
}

// Algo.gFF(new Algo.RoomGraph('W8N2'), 15,24)
// [Node 15 24],[Node 15 23],[Node 16 23],[Node 16 24],[Node 16 25],[Node 15 25],[Node 14 25],[Node 14 24],[Node 14 23],[Node 15 22],[Node 16 22],[Node 14 22],[Node 17 22],[Node 17 23],[Node 17 24]
// testggFF(new Algo.RoomGraph('W8N2'), 15,24)
// Time.measure( () => testggFF(new Algo.RoomGraph('W8N2'), 15,24) )
global.testggFF = function (graph, x, y) {
	// Stack size limit concern
	var limit = 500;
	var visual = new RoomVisual('W8N2');
	function* explore(pos) {
		let node = graph.getNode(pos.x, pos.y);
		yield node;
		visual.circle(new RoomPosition(pos.x, pos.y, 'W8N2'), { fill: 'yellow' });
		for (let child of node.getNeighbors()) {
			if (child.visited)
				continue;
			child.visited = true;
			if (--limit > 0)
				yield* explore(child);
		}
		// yield* node.getNeighbors();
	}

	for (var node of explore({ x, y })) {
		console.log('test: ' + node);
	}
}


/**
 * Find the highway from a room if possible.
 */
function findRouteToHighway(roomName, rejector = (name) => false) {
	// Best solution if we're going to call this for a lot of rooms
	// is to precalc or save some state.
	// Not yet working.
	// Want heuristic distance from highway or distance from center (%5)
	// Or we wait for generalized AStar
	var seen = {};
	var ops = 0;
	var item, rtn = [], arr = [{ name: roomName }];
	while ((item = arr.shift())) {
		var { name, EW, NS, h } = item;
		if (seen[name])
			continue;
		seen[name] = true;
		var [_, EW, NS] = /[EW](\d+)[NS](\d+)/.exec(roomName)
		if (EW % 10 == 0 || NS % 10 == 0)
			break; // goal found
		var edges = _.values(Game.map.describeExits(name));
		edges = _.reject(edges, rejector);
		edges.forEach(e => {
			// var indx = _.sortedIndex(arr, e, i => Math.abs(10 - i)
			arr.push(e)
		});
		rtn.push(name);
	}
	return rtn;
}

/**
 * MST of a room from starting position
 * example: Algo.prim(new RoomPosition(15,30,'W2N7'))
 * example: Algo.prim(new Algo.RoomGraph('W2N7'),15,29)
 * Algo.prim(new Algo.RoomGraph('W2N7'),15,29,150,_.sortedLastIndex)
 *
 * If all verticies accounted for, stop early.
 */
function prim(graph, x, y, limit = 99, fn = _.sortedIndex) {
	if (x == undefined || y == undefined)
		throw new Error("Missing arguments");
	var pq = new PriorityQueue(({ x, y, w }) => w, fn);
	pq.push({ x, y, w: 0 });
	var pos, node, rtn = [];
	var count = 0; // ,limit=15;
	var visual = Game.rooms['W2N7'].visual;
	var weight = 0;
	while ((pos = pq.pop())) {
		node = graph.getNode(pos.x, pos.y);
		if (node.visited || node.w === Infinity)
			continue;
		node.visited = true;
		if (++count > limit)
			break;
		// node.getNeighbors().forEach(p => pq.push(p));
		node.getNeighbors().forEach(p => pq.push(p));
		rtn.push(node);
		visual.text(count, node.pos);
	}
	return rtn;
}


/* function prim(rpos) {
	var {x,y,roomName} = rpos;
	var room = Game.rooms[roomName];
	var node,grid = new Grid();
	
	pq.push({x,y,w:0});
	while(node = pq.pop()) {
		console.log('Next: ' + JSON.stringify(node));
	}
} */


//
function test() {
	/* let g = new Graph;
	g.setNode(3,2,1);
	console.log('Test: ' + g.getNode(3,2));	
	let mg = new MapGraph; */
	let pq = new PriorityQueue((x) => -x);
	pq.push(42);
	pq.push(55);
	pq.push(77);
	console.log('Order: ' + pq);
}

//
module.exports = {
	Grid,
	Graph,
	MapGraph,
	RoomGraph,
	WorldGraph,

	floodFill,
	gFF,
	findRouteToHighway,
	prim,

	test
};