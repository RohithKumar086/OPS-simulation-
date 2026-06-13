/**
 * agent.js
 * Core algorithms and structures for the Micro-Fulfillment Agent.
 * Includes PriorityQueue (min-heap), WarehouseGraph, A* Pathfinder,
 * Multi-Factor Heuristic calculation, and Order Batcher.
 */

// Global Configuration
const GRID_WIDTH = 16;
const GRID_HEIGHT = 12;

// Heuristic weights (can be updated dynamically from UI)
let HEURISTIC_WEIGHTS = {
    alpha: 0.40, // Proximity to packing station
    beta: 0.25,  // Aisle congestion matrix
    gamma: 0.20, // Structural sequence safety index (Heavy -> Light -> Fragile)
    delta: 0.15  // Courier urgency factor
};

// Weight classes
const WEIGHT_CLASSES = {
    HEAVY: 'Heavy',
    LIGHT: 'Light',
    FRAGILE: 'Fragile'
};

// --- Binary Min-Heap Priority Queue ---
class PriorityQueue {
    constructor() {
        this.heap = [];
    }

    push(element, priority) {
        const node = { element, priority };
        this.heap.push(node);
        this._bubbleUp(this.heap.length - 1);
    }

    pop() {
        if (this.isEmpty()) return null;
        const top = this.heap[0];
        const bottom = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = bottom;
            this._sinkDown(0);
        }
        return top.element;
    }

    isEmpty() {
        return this.heap.length === 0;
    }

    _bubbleUp(index) {
        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);
            if (this.heap[parentIndex].priority <= this.heap[index].priority) break;
            this._swap(parentIndex, index);
            index = parentIndex;
        }
    }

    _sinkDown(index) {
        const length = this.heap.length;
        while (true) {
            let leftChildIndex = 2 * index + 1;
            let rightChildIndex = 2 * index + 2;
            let swapIndex = null;

            if (leftChildIndex < length) {
                if (this.heap[leftChildIndex].priority < this.heap[index].priority) {
                    swapIndex = leftChildIndex;
                }
            }

            if (rightChildIndex < length) {
                const currentBest = swapIndex === null ? this.heap[index] : this.heap[leftChildIndex];
                if (this.heap[rightChildIndex].priority < currentBest.priority) {
                    swapIndex = rightChildIndex;
                }
            }

            if (swapIndex === null) break;
            this._swap(index, swapIndex);
            index = swapIndex;
        }
    }

    _swap(i, j) {
        const temp = this.heap[i];
        this.heap[i] = this.heap[j];
        this.heap[j] = temp;
    }
}

// --- Warehouse Graph and Layout Specification ---
class WarehouseGraph {
    constructor() {
        this.width = GRID_WIDTH;
        this.height = GRID_HEIGHT;
        this.grid = Array(this.width).fill(null).map(() => Array(this.height).fill('shelf'));
        this._initLayout();
    }

    _initLayout() {
        // Define paths (walkways & aisles)
        // Walkways
        for (let x = 0; x < this.width; x++) {
            this.grid[x][0] = 'walkway';  // Top cross-walkway
            this.grid[x][5] = 'walkway';  // Middle cross-walkway
            this.grid[x][11] = 'walkway'; // Bottom cross-walkway
        }
        for (let y = 0; y < this.height; y++) {
            this.grid[0][y] = 'walkway';  // Left outer walkway
            this.grid[15][y] = 'walkway'; // Right outer walkway
        }

        // Aisles (vertical paths connecting walkways)
        const aisleCols = [2, 5, 8, 11, 14];
        for (const x of aisleCols) {
            for (let y = 0; y < this.height; y++) {
                this.grid[x][y] = 'aisle';
            }
        }

        // Packing stations
        this.packingBays = [
            { id: 1, x: 4, y: 11, name: 'Pack Bay A' },
            { id: 2, x: 12, y: 11, name: 'Pack Bay B' }
        ];

        for (const bay of this.packingBays) {
            this.grid[bay.x][bay.y] = 'packing';
        }

        // Staging / Start zone
        this.grid[0][0] = 'staging';
    }

    isPath(x, y) {
        if (x < 0 || x >= this.width || y < 0 || y >= this.height) return false;
        const cell = this.grid[x][y];
        return cell === 'walkway' || cell === 'aisle' || cell === 'staging' || cell === 'packing';
    }

    // Returns traversable neighbors of a path node
    getNeighbors(x, y) {
        const neighbors = [];
        const dirs = [
            { dx: 0, dy: -1 }, // Up
            { dx: 0, dy: 1 },  // Down
            { dx: -1, dy: 0 }, // Left
            { dx: 1, dy: 0 }   // Right
        ];

        for (const dir of dirs) {
            const nx = x + dir.dx;
            const ny = y + dir.dy;
            if (this.isPath(nx, ny)) {
                neighbors.push({ x: nx, y: ny });
            }
        }
        return neighbors;
    }

    // Find paths from a shelf (x, y) to its accessible adjacent path coordinates
    getAccessPoints(shelfX, shelfY) {
        const access = [];
        const dirs = [
            { dx: 0, dy: -1 },
            { dx: 0, dy: 1 },
            { dx: -1, dy: 0 },
            { dx: 1, dy: 0 }
        ];
        for (const dir of dirs) {
            const px = shelfX + dir.dx;
            const py = shelfY + dir.dy;
            if (this.isPath(px, py)) {
                access.push({ x: px, y: py });
            }
        }
        return access;
    }
}

// --- Multi-Constraint A* Pathfinder ---
class AStarPathfinder {
    constructor(graph) {
        this.graph = graph;
    }

    /**
     * Finds the optimal path for a picker to retrieve a batch of items and end at a packing bay.
     * State representation in search space: (x, y, picked_mask)
     * @param {Object} start {x, y}
     * @param {Array} batchItems Array of SKU objects to be picked
     * @param {Object} packingBay {x, y}
     * @param {Object} trafficMap 2D array or object tracking edge/cell congestion
     * @param {Object} courier Tracker details (ETA, SLA)
     * @param {number} currentTime
     */
    findPath(start, batchItems, packingBay, trafficMap, courier, currentTime) {
        const K = batchItems.length;
        const goalMask = (1 << K) - 1;

        const openSet = new PriorityQueue();
        // Key format: "x,y,mask"
        const startState = { x: start.x, y: start.y, mask: 0, pathHistory: [] };
        
        // Cost tracking maps
        const gScore = new Map();
        const startKey = `${start.x},${start.y},0`;
        gScore.set(startKey, 0);

        // Parent tracking to reconstruct path
        const parentMap = new Map();

        // Push start state with fScore = 0 + heuristic
        const initialH = this._calculateHeuristic(start.x, start.y, 0, batchItems, packingBay, trafficMap, courier, currentTime);
        openSet.push(startState, initialH);

        let iterations = 0;
        const maxIterations = 15000; // Prevent infinite loops in edge cases

        while (!openSet.isEmpty()) {
            iterations++;
            if (iterations > maxIterations) {
                console.warn("A* reached max iterations without finding path.");
                break;
            }

            const current = openSet.pop();
            const currentKey = `${current.x},${current.y},${current.mask}`;

            // Check if we reached the goal: at packing bay AND all items picked
            if (current.x === packingBay.x && current.y === packingBay.y && current.mask === goalMask) {
                return this._reconstructPath(parentMap, currentKey, batchItems);
            }

            const currentG = gScore.get(currentKey) ?? Infinity;

            // 1. Evaluate movement transitions to adjacent path nodes
            const neighbors = this.graph.getNeighbors(current.x, current.y);
            for (const neighbor of neighbors) {
                const neighborKey = `${neighbor.x},${neighbor.y},${current.mask}`;
                
                // Travel cost calculation g(n) modulated by traffic
                const trafficPenalty = trafficMap[neighbor.x]?.[neighbor.y] || 0;
                // Base cost 1, traffic scales the cost
                const moveCost = 1 + (trafficPenalty * 1.5); 
                const tentativeG = currentG + moveCost;

                if (tentativeG < (gScore.get(neighborKey) ?? Infinity)) {
                    gScore.set(neighborKey, tentativeG);
                    
                    const nextState = {
                        x: neighbor.x,
                        y: neighbor.y,
                        mask: current.mask,
                        pathHistory: [...current.pathHistory, { x: current.x, y: current.y, action: 'move' }]
                    };
                    
                    parentMap.set(neighborKey, { key: currentKey, action: 'move', x: neighbor.x, y: neighbor.y });
                    
                    const h = this._calculateHeuristic(neighbor.x, neighbor.y, current.mask, batchItems, packingBay, trafficMap, courier, currentTime);
                    openSet.push(nextState, tentativeG + h);
                }
            }

            // 2. Evaluate picking transitions (if standing adjacent to an unpicked item in the batch)
            for (let i = 0; i < K; i++) {
                // If item not yet picked in this state
                if ((current.mask & (1 << i)) === 0) {
                    const item = batchItems[i];
                    // Check if current coordinate is adjacent to the item's shelf coordinate
                    const isAdjacent = Math.abs(current.x - item.x) + Math.abs(current.y - item.y) <= 1;
                    
                    if (isAdjacent) {
                        const nextMask = current.mask | (1 << i);
                        const nextKey = `${current.x},${current.y},${nextMask}`;
                        
                        // Small cost representing picking time (e.g. 2 units)
                        const pickCost = 2;
                        const tentativeG = currentG + pickCost;

                        if (tentativeG < (gScore.get(nextKey) ?? Infinity)) {
                            gScore.set(nextKey, tentativeG);
                            
                            const nextState = {
                                x: current.x,
                                y: current.y,
                                mask: nextMask,
                                pathHistory: [...current.pathHistory, { x: current.x, y: current.y, action: `pick:${item.id}` }]
                            };

                            parentMap.set(nextKey, { key: currentKey, action: `pick:${item.id}`, x: current.x, y: current.y, skuId: item.id });
                            
                            const h = this._calculateHeuristic(current.x, current.y, nextMask, batchItems, packingBay, trafficMap, courier, currentTime);
                            openSet.push(nextState, tentativeG + h);
                        }
                    }
                }
            }
        }

        return null; // Path not found
    }

    /**
     * Finds a path from a start position to a single target coordinate.
     * If the target is a shelf, it paths to any adjacent path cell.
     */
    findSingleTargetAStar(start, target, trafficMap) {
        const isTargetPath = this.graph.isPath(target.x, target.y);
        const goals = isTargetPath ? [{ x: target.x, y: target.y }] : this.graph.getAccessPoints(target.x, target.y);
        
        if (goals.length === 0) return null;

        const isStartGoal = goals.some(g => g.x === start.x && g.y === start.y);
        if (isStartGoal) {
            return [{ x: start.x, y: start.y }];
        }

        const openSet = new PriorityQueue();
        const startState = { x: start.x, y: start.y };
        
        const gScore = new Map();
        const startKey = `${start.x},${start.y}`;
        gScore.set(startKey, 0);

        const parentMap = new Map();
        
        const getHeuristic = (x, y) => {
            let minDist = Infinity;
            for (const goal of goals) {
                const dist = Math.abs(x - goal.x) + Math.abs(y - goal.y);
                if (dist < minDist) minDist = dist;
            }
            return minDist;
        };

        openSet.push(startState, getHeuristic(start.x, start.y));

        let iterations = 0;
        const maxIterations = 5000;

        while (!openSet.isEmpty()) {
            iterations++;
            if (iterations > maxIterations) break;

            const current = openSet.pop();
            const currentKey = `${current.x},${current.y}`;

            const reachedGoal = goals.some(g => g.x === current.x && g.y === current.y);
            if (reachedGoal) {
                const path = [];
                let currKey = currentKey;
                while (parentMap.has(currKey)) {
                    const node = parentMap.get(currKey);
                    path.push({ x: node.x, y: node.y });
                    currKey = node.parentKey;
                }
                path.reverse();
                path.push({ x: current.x, y: current.y });
                return path;
            }

            const currentG = gScore.get(currentKey) ?? Infinity;
            const neighbors = this.graph.getNeighbors(current.x, current.y);

            for (const neighbor of neighbors) {
                const neighborKey = `${neighbor.x},${neighbor.y}`;
                const trafficPenalty = trafficMap[neighbor.x]?.[neighbor.y] || 0;
                const moveCost = 1 + (trafficPenalty * 1.5);
                const tentativeG = currentG + moveCost;

                if (tentativeG < (gScore.get(neighborKey) ?? Infinity)) {
                    gScore.set(neighborKey, tentativeG);
                    parentMap.set(neighborKey, { parentKey: currentKey, x: current.x, y: current.y });
                    
                    const fScore = tentativeG + getHeuristic(neighbor.x, neighbor.y);
                    openSet.push({ x: neighbor.x, y: neighbor.y }, fScore);
                }
            }
        }

        return null;
    }

    /**
     * Shortest Seek Time First (SSTF) Routing Algorithm.
     * Greedy sequence optimization: always routes to the closest remaining unpicked item.
     */
    findPathSSTF(start, batchItems, packingBay, trafficMap) {
        let currentPos = { x: start.x, y: start.y };
        const remainingItems = [...batchItems];
        let fullPath = [{ x: start.x, y: start.y, action: 'start' }];
        
        while (remainingItems.length > 0) {
            let closestIdx = -1;
            let minDist = Infinity;
            
            for (let i = 0; i < remainingItems.length; i++) {
                const item = remainingItems[i];
                const dist = Math.abs(currentPos.x - item.x) + Math.abs(currentPos.y - item.y);
                if (dist < minDist) {
                    minDist = dist;
                    closestIdx = i;
                }
            }
            
            if (closestIdx === -1) break;
            const nextItem = remainingItems.splice(closestIdx, 1)[0];
            
            const segment = this.findSingleTargetAStar(currentPos, nextItem, trafficMap);
            if (segment) {
                // Append movement steps
                for (let i = 1; i < segment.length; i++) {
                    fullPath.push({ x: segment[i].x, y: segment[i].y, action: 'move' });
                }
                // Append picking step at the destination node
                const lastNode = segment[segment.length - 1];
                fullPath.push({ 
                    x: lastNode.x, 
                    y: lastNode.y, 
                    action: `pick:${nextItem.id}`, 
                    skuId: nextItem.id 
                });
                currentPos = lastNode;
            } else {
                console.warn(`SSTF: could not path to SKU ${nextItem.id}`);
                return null;
            }
        }
        
        // Final path segment to designated Packing Bay
        const finalSegment = this.findSingleTargetAStar(currentPos, packingBay, trafficMap);
        if (finalSegment) {
            for (let i = 1; i < finalSegment.length; i++) {
                fullPath.push({ x: finalSegment[i].x, y: finalSegment[i].y, action: 'move' });
            }
        } else {
            console.warn("SSTF: could not path to Packing Bay");
            return null;
        }
        
        return fullPath;
    }

    /**
     * Custom Multi-Factor Heuristic Function h(n)
     */
    _calculateHeuristic(x, y, mask, batchItems, packingBay, trafficMap, courier, currentTime) {
        const { alpha, beta, gamma, delta } = HEURISTIC_WEIGHTS;

        // 1. Proximity Vector (Manhattan distance to target packing station)
        const dPack = Math.abs(x - packingBay.x) + Math.abs(y - packingBay.y);
        
        // Find remaining items to pick
        const K = batchItems.length;
        let dItems = 0;
        let unpickedCount = 0;
        for (let i = 0; i < K; i++) {
            if ((mask & (1 << i)) === 0) {
                const item = batchItems[i];
                dItems += Math.abs(x - item.x) + Math.abs(y - item.y);
                unpickedCount++;
            }
        }
        
        // h_prox: If there are unpicked items, we guide the search towards unpicked items.
        // Otherwise, we guide it straight to the packing station.
        const h_prox = unpickedCount > 0 ? (dItems / unpickedCount) + dPack * 0.3 : dPack;

        // 2. Aisle Congestion Matrix (based on traffic map)
        // Add localized congestion score around the candidate coordinate
        const h_cong = trafficMap[x]?.[y] || 0;

        // 3. Structural Sequence Safety Index (Heavy -> Light -> Fragile)
        // Severe penalty if we picked fragile items, but heavy/light items are still unpicked.
        let h_seq = 0;
        let hasFragilePicked = false;
        let hasLightPicked = false;
        let hasHeavyUnpicked = false;
        let hasLightUnpicked = false;

        for (let i = 0; i < K; i++) {
            const isPicked = (mask & (1 << i)) !== 0;
            const weightClass = batchItems[i].weightClass;

            if (isPicked && weightClass === WEIGHT_CLASSES.FRAGILE) hasFragilePicked = true;
            if (isPicked && weightClass === WEIGHT_CLASSES.LIGHT) hasLightPicked = true;
            if (!isPicked && weightClass === WEIGHT_CLASSES.HEAVY) hasHeavyUnpicked = true;
            if (!isPicked && weightClass === WEIGHT_CLASSES.LIGHT) hasLightUnpicked = true;
        }

        // Violations:
        // - Fragile picked, but Heavy is still outstanding
        if (hasFragilePicked && hasHeavyUnpicked) {
            h_seq += 200; // Major structural hazard penalty
        }
        // - Fragile picked, but Light is still outstanding
        if (hasFragilePicked && hasLightUnpicked) {
            h_seq += 100; // Moderate hazard penalty
        }
        // - Light picked, but Heavy is still outstanding
        if (hasLightPicked && hasHeavyUnpicked) {
            h_seq += 80;  // Minor hazard penalty
        }

        // 4. Courier Urgency Factor
        // ETA or SLA remaining time. Lower ETA -> Higher Urgency -> Higher penalty for remaining items.
        let h_urg = 0;
        if (courier && unpickedCount > 0) {
            const timeRemaining = Math.max(0, (courier.slaDeadline - currentTime) / 1000);
            const eta = courier.etaSeconds || 120;
            // Higher urgency when remaining time or courier ETA is extremely short
            const urgencyFactor = Math.max(1, 150 - Math.min(timeRemaining, eta));
            h_urg = unpickedCount * urgencyFactor;
        }

        // Return combined weighted heuristic
        return (alpha * h_prox) + (beta * h_cong * 15) + (gamma * h_seq) + (delta * h_urg * 0.1);
    }

    _reconstructPath(parentMap, goalKey, batchItems) {
        const fullPath = [];
        let currentKey = goalKey;

        while (parentMap.has(currentKey)) {
            const step = parentMap.get(currentKey);
            fullPath.push({
                x: step.x,
                y: step.y,
                action: step.action,
                skuId: step.skuId
            });
            currentKey = step.key;
        }

        fullPath.reverse();
        
        // Add start position as the first item
        const parts = currentKey.split(',');
        const startX = parseInt(parts[0]);
        const startY = parseInt(parts[1]);
        fullPath.unshift({ x: startX, y: startY, action: 'start' });

        return fullPath;
    }
}

// --- Dynamic Order Batcher ---
class OrderBatcher {
    /**
     * Batches unassigned orders using item spatial density and proximity.
     * @param {Array} unassignedOrders List of unassigned order objects
     * @param {Array} skus List of all SKU metadata
     * @param {number} maxBatchSize Limit of items per batch (default: 4)
     */
    static generateBatches(unassignedOrders, skus, maxBatchSize = 4) {
        if (unassignedOrders.length === 0) return [];

        const batches = [];
        // Map SKUs for quick lookup
        const skuMap = new Map(skus.map(s => [s.id, s]));

        // Clone and sort orders by SLA deadline (earliest deadline first)
        const sortedOrders = [...unassignedOrders].sort((a, b) => a.slaDeadline - b.slaDeadline);

        while (sortedOrders.length > 0) {
            const baseOrder = sortedOrders.shift();
            const currentBatchItems = [];
            const batchOrders = [baseOrder];

            // Add base order items
            for (const itemId of baseOrder.itemsRequested) {
                const sku = skuMap.get(itemId);
                if (sku) {
                    currentBatchItems.push({
                        orderId: baseOrder.id,
                        ...sku
                    });
                }
            }

            // Attempt to merge nearby orders until batch size is reached
            let i = 0;
            while (i < sortedOrders.length && currentBatchItems.length < maxBatchSize) {
                const candidateOrder = sortedOrders[i];
                const candidateItems = candidateOrder.itemsRequested.map(id => skuMap.get(id)).filter(Boolean);

                // Check if merging candidate exceeds max size
                if (currentBatchItems.length + candidateItems.length <= maxBatchSize) {
                    // Check if candidate items are spatially close to existing batch items
                    // Measure distance from candidate items to current batch centroid
                    let totalDist = 0;
                    for (const cItem of candidateItems) {
                        for (const bItem of currentBatchItems) {
                            totalDist += Math.abs(cItem.x - bItem.x) + Math.abs(cItem.y - bItem.y);
                        }
                    }
                    const avgDist = totalDist / (currentBatchItems.length * candidateItems.length || 1);

                    // If average Manhattan distance is within threshold (e.g., 8 blocks)
                    if (avgDist <= 8.0) {
                        // Merge order
                        sortedOrders.splice(i, 1);
                        batchOrders.push(candidateOrder);
                        for (const item of candidateItems) {
                            currentBatchItems.push({
                                orderId: candidateOrder.id,
                                ...item
                            });
                        }
                        // Don't increment index since we removed the element
                        continue;
                    }
                }
                i++;
            }

            batches.push({
                id: `batch-${Math.random().toString(36).substr(2, 5)}`,
                orders: batchOrders,
                items: currentBatchItems,
                status: 'Batched',
                createdTime: Date.now()
            });
        }

        return batches;
    }
}

// Export modules for frontend or testing
if (typeof module !== 'undefined') {
    module.exports = {
        PriorityQueue,
        WarehouseGraph,
        AStarPathfinder,
        OrderBatcher,
        WEIGHT_CLASSES,
        HEURISTIC_WEIGHTS,
        GRID_WIDTH,
        GRID_HEIGHT
    };
}
