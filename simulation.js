/**
 * simulation.js
 * Multi-picker concurrent simulation loop, inventory management,
 * Mutex locks, event queues, and telemetry streams.
 */

// Import classes if running in Node (for tests)
let WarehouseGraphClass, AStarPathfinderClass, OrderBatcherClass, WEIGHT_CLASSES_VAL, HEURISTIC_WEIGHTS_VAL;
let simGridWidth, simGridHeight;

if (typeof require !== 'undefined') {
    const agent = require('./agent');
    WarehouseGraphClass = agent.WarehouseGraph;
    AStarPathfinderClass = agent.AStarPathfinder;
    OrderBatcherClass = agent.OrderBatcher;
    WEIGHT_CLASSES_VAL = agent.WEIGHT_CLASSES;
    HEURISTIC_WEIGHTS_VAL = agent.HEURISTIC_WEIGHTS;
    simGridWidth = agent.GRID_WIDTH;
    simGridHeight = agent.GRID_HEIGHT;
} else {
    WarehouseGraphClass = WarehouseGraph;
    AStarPathfinderClass = AStarPathfinder;
    OrderBatcherClass = OrderBatcher;
    WEIGHT_CLASSES_VAL = WEIGHT_CLASSES;
    HEURISTIC_WEIGHTS_VAL = HEURISTIC_WEIGHTS;
    simGridWidth = typeof GRID_WIDTH !== 'undefined' ? GRID_WIDTH : 16;
    simGridHeight = typeof GRID_HEIGHT !== 'undefined' ? GRID_HEIGHT : 12;
}

class Simulation {
    constructor() {
        this.graph = new WarehouseGraphClass();
        this.pathfinder = new AStarPathfinderClass(this.graph);

        // Core State Space
        this.skus = [];
        this.pickers = [];
        this.orders = [];
        this.batches = [];
        this.couriers = [];
        this.traffic = Array(simGridWidth).fill(0).map(() => Array(simGridHeight).fill(0));
        
        // Mutex Lock Registry for SKUs
        this.skuLocks = new Map(); // SKU_ID -> boolean (isLocked)
        
        // Master Clock & KPIs
        this.currentTime = Date.now();
        this.startTime = this.currentTime;
        this.kpis = {
            totalOrdersFulfilled: 0,
            totalOrdersFailedSLA: 0,
            ordersProcessedPerHour: 0,
            averagePickCycleTimeMs: 0,
            cumulativeWalkingDistance: 0,
            walkingDistanceReduction: 0, // compared to static baseline
            productDamageCount: 0,
            crushRate: 0, // percentage of fragile items crushed
            slaCompliancePercent: 100,
            locksAcquired: 0,
            lockContentionCount: 0
        };

        // Static baseline distance tracker for KPI calculation
        this.staticBaselineDistance = 0;
        this.actualPickerDistance = 0;

        // Logging system
        this.logs = [];
        
        this.routingMode = 'AStar'; // 'AStar' or 'SSTF'
        this.pipelineState = {
            receive: { text: 'Waiting', active: false, timestamp: 0 },
            priority: { text: 'Waiting', active: false, timestamp: 0 },
            preemption: { text: 'Waiting', active: false, timestamp: 0 },
            sstf: { text: 'Waiting', active: false, timestamp: 0 },
            move: { text: 'Waiting', active: false, timestamp: 0 }
        };

        // Gantt Chart History - records scheduling events per picker
        // Each entry: { pickerId, type, batchId, priority, startTick, endTick, preemptedBy }
        this.ganttHistory = [];
        this.ganttTick = 0; // Incremental tick counter for Gantt x-axis
        // Track current segment per picker
        this._ganttCurrentSegment = {}; // pickerId -> current segment object
        this._ganttResumedFlag = {}; // pickerId -> true if batch just resumed (forces new segment)
        // Track arrival events for timeline markers
        this.ganttArrivals = []; // { tick, batchId, priority, orderId }
        // Track context switches (resume events)
        this.ganttResumes = []; // { tick, pickerId, batchId }
        // Process table: batchId -> { arrivalTick, startTick, completionTick, priority, orders, pickerId, waitingTime, turnaroundTime }
        this.ganttProcessTable = new Map();

        this._initSKUs();
        this._initPickers();
    }

    updatePipeline(step, text, active = true) {
        if (this.pipelineState[step]) {
            this.pipelineState[step].text = text;
            this.pipelineState[step].active = active;
            this.pipelineState[step].timestamp = this.currentTime;
        }
    }

    log(message, type = 'info') {
        const timestamp = new Date(this.currentTime).toLocaleTimeString([], { hour12: false });
        const logEntry = { timestamp, message, type, id: Math.random().toString(36).substr(2, 9) };
        this.logs.unshift(logEntry);
        if (this.logs.length > 100) this.logs.pop();
        
        // Trigger UI event if listener exists
        if (this.onLogAdded) this.onLogAdded(logEntry);
    }

    _initSKUs() {
        // Distribute ~40 SKUs across the shelves.
        // Shelving columns are: X = 1, 3, 4, 6, 7, 9, 10, 12, 13
        // Shelving rows are: Y = 1, 2, 3, 4, 6, 7, 8, 9, 10
        const shelfCols = [1, 3, 4, 6, 7, 9, 10, 12, 13];
        const shelfRows = [1, 2, 3, 4, 6, 7, 8, 9, 10];

        const products = [
            // HEAVY ITEMS
            { name: 'Liquid Detergent 5L', weight: WEIGHT_CLASSES_VAL.HEAVY, symbol: '🧴' },
            { name: 'Water Bottle Pack 24x', weight: WEIGHT_CLASSES_VAL.HEAVY, symbol: '📦' },
            { name: 'Rice Sack 10kg', weight: WEIGHT_CLASSES_VAL.HEAVY, symbol: '🌾' },
            { name: 'Olive Oil Tin 5L', weight: WEIGHT_CLASSES_VAL.HEAVY, symbol: '🛢️' },
            { name: 'Cat Litter Bag 8kg', weight: WEIGHT_CLASSES_VAL.HEAVY, symbol: '🐈' },
            { name: 'Canned Bean Tray 12x', weight: WEIGHT_CLASSES_VAL.HEAVY, symbol: '🥫' },
            { name: 'Soda Can Pack 24x', weight: WEIGHT_CLASSES_VAL.HEAVY, symbol: '🥤' },
            
            // LIGHT ITEMS
            { name: 'Fusilli Pasta 500g', weight: WEIGHT_CLASSES_VAL.LIGHT, symbol: '🍝' },
            { name: 'Chocolate Cookies', weight: WEIGHT_CLASSES_VAL.LIGHT, symbol: '🍪' },
            { name: 'Corn Flakes Cereal', weight: WEIGHT_CLASSES_VAL.LIGHT, symbol: '🥣' },
            { name: 'Toothpaste 150ml', weight: WEIGHT_CLASSES_VAL.LIGHT, symbol: '🪥' },
            { name: 'Toilet Paper 12 Rolls', weight: WEIGHT_CLASSES_VAL.LIGHT, symbol: '🧻' },
            { name: 'Basmati Rice 1kg', weight: WEIGHT_CLASSES_VAL.LIGHT, symbol: '🍚' },
            { name: 'Ground Coffee 250g', weight: WEIGHT_CLASSES_VAL.LIGHT, symbol: '☕' },
            { name: 'Tea Bags 100x', weight: WEIGHT_CLASSES_VAL.LIGHT, symbol: '🍵' },
            { name: 'Paper Towels 2x', weight: WEIGHT_CLASSES_VAL.LIGHT, symbol: '🧽' },
            { name: 'Dish Soap 500ml', weight: WEIGHT_CLASSES_VAL.LIGHT, symbol: '🧴' },

            // FRAGILE ITEMS
            { name: 'Fresh Eggs 12x', weight: WEIGHT_CLASSES_VAL.FRAGILE, symbol: '🥚' },
            { name: 'Sliced Bread 500g', weight: WEIGHT_CLASSES_VAL.FRAGILE, symbol: '🍞' },
            { name: 'Organic Cherry Tomatoes', weight: WEIGHT_CLASSES_VAL.FRAGILE, symbol: '🍅' },
            { name: 'Glass Honey Jar 400g', weight: WEIGHT_CLASSES_VAL.FRAGILE, symbol: '🍯' },
            { name: 'Glass Milk Bottle 1L', weight: WEIGHT_CLASSES_VAL.FRAGILE, symbol: '🥛' },
            { name: 'Fresh Raspberries 200g', weight: WEIGHT_CLASSES_VAL.FRAGILE, symbol: '🍓' },
            { name: 'Potato Chips Bag 150g', weight: WEIGHT_CLASSES_VAL.FRAGILE, symbol: '🍿' },
            { name: 'Fragile Red Wine 750ml', weight: WEIGHT_CLASSES_VAL.FRAGILE, symbol: '🍷' }
        ];

        let skuCounter = 1;

        // Populate SKUs systematically
        for (const col of shelfCols) {
            for (const row of shelfRows) {
                // Determine weight class based on col/row to create cluster-like sections
                // Example: Chilled/Fragile items grouped in certain zones, heavy in others
                let prodTemplate;
                if (col <= 3) {
                    // Heavy items in the left rows
                    const heavyProds = products.filter(p => p.weight === WEIGHT_CLASSES_VAL.HEAVY);
                    prodTemplate = heavyProds[(col + row) % heavyProds.length];
                } else if (col >= 12) {
                    // Fragile items in the right columns (near Pack Bay B)
                    const fragileProds = products.filter(p => p.weight === WEIGHT_CLASSES_VAL.FRAGILE);
                    prodTemplate = fragileProds[(col + row) % fragileProds.length];
                } else {
                    // Light items in the middle columns
                    const lightProds = products.filter(p => p.weight === WEIGHT_CLASSES_VAL.LIGHT);
                    prodTemplate = lightProds[(col + row) % lightProds.length];
                }

                // Alternate some positions to have a mix everywhere
                if ((col + row) % 7 === 0) {
                    const fragileProds = products.filter(p => p.weight === WEIGHT_CLASSES_VAL.FRAGILE);
                    prodTemplate = fragileProds[row % fragileProds.length];
                }

                const skuId = `SKU-${skuCounter.toString().padStart(3, '0')}`;
                skuCounter++;

                this.skus.push({
                    id: skuId,
                    name: prodTemplate.name,
                    x: col,
                    y: row,
                    stock: 12, // Starting stock
                    maxStock: 12,
                    weightClass: prodTemplate.weight,
                    symbol: prodTemplate.symbol,
                    turnoverRate: Math.random() > 0.6 ? 'High' : 'Medium'
                });

                this.skuLocks.set(skuId, false); // Initialize lock to open
            }
        }
    }

    _initPickers() {
        const pickerNames = ['Picker Delta', 'Picker Echo', 'Picker Foxtrot'];
        const colors = ['#10b981', '#3b82f6', '#ec4899']; // Green, Blue, Pink
        for (let i = 0; i < 3; i++) {
            this.pickers.push({
                id: `PKR-${(i + 1).toString().padStart(2, '0')}`,
                name: pickerNames[i],
                x: 0,
                y: 0,
                color: colors[i],
                status: 'Idle', // Idle, Picking, Packing
                assignedBatch: null,
                path: null,
                pathIndex: 0,
                binWeight: 0,
                cartContents: [], // Items collected
                currentTaskTime: 0,
                totalDistanceWalked: 0,
                blockedTicks: 0,
                suspendedBatch: null,
                suspendedCart: null
            });
        }
    }

    // Spawn an order
    spawnOrder(itemCount = 3, priority = 1) {
        const orderId = `ORD-${Math.floor(1000 + Math.random() * 9000)}`;
        const selectedItems = [];
        
        // Randomly select distinct SKUs
        const availableSKUs = [...this.skus].filter(s => s.stock > 0);
        if (availableSKUs.length === 0) return null;

        const count = Math.min(itemCount, availableSKUs.length);
        for (let i = 0; i < count; i++) {
            const index = Math.floor(Math.random() * availableSKUs.length);
            selectedItems.push(availableSKUs[index].id);
            availableSKUs.splice(index, 1);
        }

        // Set SLA deadline (e.g. between 60 to 120 seconds in the future)
        const slaDuration = (60 + Math.floor(Math.random() * 60)) * 1000;
        const slaDeadline = this.currentTime + slaDuration;

        const newOrder = {
            id: orderId,
            itemsRequested: selectedItems,
            status: 'Unassigned',
            createdTime: this.currentTime,
            slaDeadline: slaDeadline,
            priority: priority
        };

        this.orders.push(newOrder);
        this.log(`New Order ${orderId} arrived with ${count} items. SLA Deadline in ${Math.round(slaDuration / 1000)}s.`, 'order');
        
        this.updatePipeline('receive', `Order ${orderId} received (${count} items)`);
        this.updatePipeline('priority', `Order ${orderId}: ${priority === 3 ? '🚨 EMERGENCY' : 'Normal (Priority 1)'}`);
        
        // Assign a courier for this order
        this._spawnCourier(orderId, slaDeadline);

        // Run batching after order spawn
        this.triggerBatching();

        return newOrder;
    }

    _spawnCourier(orderId, slaDeadline) {
        const courierId = `CR-${Math.floor(100 + Math.random() * 900)}`;
        const etaSeconds = 40 + Math.floor(Math.random() * 45); // 40-85 seconds
        const bayNumber = Math.random() > 0.5 ? 1 : 2;

        const courier = {
            id: courierId,
            assignedOrderIds: [orderId],
            etaSeconds: etaSeconds,
            slaDeadline: slaDeadline,
            bayNumber: bayNumber,
            status: 'EnRoute' // EnRoute, Arrived, Departed
        };

        this.couriers.push(courier);
    }

    triggerBatching() {
        const unassigned = this.orders.filter(o => o.status === 'Unassigned');
        if (unassigned.length === 0) return;

        const newBatches = OrderBatcherClass.generateBatches(unassigned, this.skus, 4);
        
        for (const batch of newBatches) {
            batch.priority = Math.max(...batch.orders.map(o => o.priority || 1));
            this.batches.push(batch);
            
            // Mark orders in batch as Batched
            for (const order of batch.orders) {
                const found = this.orders.find(o => o.id === order.id);
                if (found) found.status = 'Batched';
            }
            
            this.log(`Grouped ${batch.orders.length} orders into Batch ${batch.id}.`, 'batch');

            // Record arrival for Gantt chart
            this.ganttArrivals.push({
                tick: this.ganttTick,
                batchId: batch.id,
                priority: batch.priority,
                orderIds: batch.orders.map(o => o.id)
            });
            // Initialize process table entry
            this.ganttProcessTable.set(batch.id, {
                arrivalTick: this.ganttTick,
                startTick: null,
                completionTick: null,
                priority: batch.priority,
                orderIds: batch.orders.map(o => o.id),
                pickerId: null,
                status: 'Waiting'
            });
        }

        this._assignBatchesToIdlePickers();
    }

    _assignBatchesToIdlePickers() {
        const idlePickers = this.pickers.filter(p => p.status === 'Idle');
        const unassignedBatches = this.batches.filter(b => b.status === 'Batched')
            .sort((a, b) => (b.priority || 1) - (a.priority || 1));

        for (const picker of idlePickers) {
            if (unassignedBatches.length === 0) break;
            const batch = unassignedBatches.shift();
            this._assignBatchToPicker(picker, batch);
            this.updatePipeline('preemption', `Assigned ${picker.name} (no preemption needed)`, false);
        }

        if (unassignedBatches.length > 0) {
            this._preemptActivePickers(unassignedBatches);
        }
    }

    _preemptActivePickers(unassignedBatches) {
        const emergencyBatches = unassignedBatches.filter(b => (b.priority || 1) >= 3);
        if (emergencyBatches.length === 0) return;

        for (const batch of emergencyBatches) {
            // Find a picker who is currently Picking a normal order (priority = 1) and does not already have a suspended batch
            const candidates = this.pickers.filter(p => 
                p.status === 'Picking' && 
                (!p.assignedBatch || (p.assignedBatch.priority || 1) === 1) &&
                !p.suspendedBatch
            );

            if (candidates.length === 0) break; // No candidates available to preempt

            const picker = candidates[0];

            this.log(`⚡ Preemption Event: ${picker.name} suspended (Batch ${picker.assignedBatch.id}) -> Assigned Emergency Batch ${batch.id}.`, 'warning');
            this.updatePipeline('preemption', `⚡ Preempted ${picker.name.split(' ')[1]}`);

            // Record preemption in Gantt chart
            const currentSeg = this._ganttCurrentSegment[picker.id];
            if (currentSeg) {
                // End the current segment at ganttTick - 1
                currentSeg.endTick = this.ganttTick - 1;
                if (currentSeg.endTick >= currentSeg.startTick) {
                    this.ganttHistory.push({ ...currentSeg });
                }
                
                // Add a 1-tick 'preempted' segment to show preemption event at ganttTick
                this.ganttHistory.push({
                    pickerId: picker.id,
                    pickerName: picker.name,
                    pickerColor: picker.color,
                    type: 'preempted',
                    batchId: currentSeg.batchId,
                    priority: currentSeg.priority,
                    startTick: this.ganttTick,
                    endTick: this.ganttTick,
                    preemptedBy: batch.id
                });
                
                this._ganttCurrentSegment[picker.id] = null;
            }

            // Set suspended batch status in process table to Suspended
            const suspendedPtEntry = this.ganttProcessTable.get(picker.assignedBatch.id);
            if (suspendedPtEntry) {
                suspendedPtEntry.status = 'Suspended';
            }

            // Track emergency batch start in process table
            const emergencyPtEntry = this.ganttProcessTable.get(batch.id);
            if (emergencyPtEntry && emergencyPtEntry.startTick === null) {
                emergencyPtEntry.startTick = this.ganttTick;
                emergencyPtEntry.pickerId = picker.id;
                emergencyPtEntry.status = 'Running';
            }

            // Suspend current task
            picker.suspendedBatch = picker.assignedBatch;
            picker.suspendedCart = [...picker.cartContents];
            
            // Clear current picking state
            picker.cartContents = [];
            picker.binWeight = 0;
            picker.path = null;
            picker.pathIndex = 0;
            picker.blockedTicks = 0;
            
            // Set the new batch status
            batch.status = 'Processing';
            for (const order of batch.orders) {
                const found = this.orders.find(o => o.id === order.id);
                if (found) found.status = 'Processing';
            }

            // Assign the emergency batch
            picker.assignedBatch = batch;
            const packBay = this._selectOptimalPackingBay(batch.items);
            picker.targetPackingBay = packBay;
            picker.status = 'Picking';

            // Recalculate path
            this.recalculatePickerPath(picker);
        }
    }

    _assignBatchToPicker(picker, batch) {
        picker.status = 'Picking';
        picker.assignedBatch = batch;
        picker.binWeight = 0;
        picker.cartContents = [];
        picker.pathIndex = 0;
        picker.blockedTicks = 0;
        batch.status = 'Processing';

        // Set status of orders in batch to Processing
        for (const order of batch.orders) {
            const found = this.orders.find(o => o.id === order.id);
            if (found) found.status = 'Processing';
        }

        // Determine packing bay (assign to the one closer to the items or less loaded)
        // Let's use Pack Bay A (index 0) or Pack Bay B (index 1) based on item coordinates
        const packBay = this._selectOptimalPackingBay(batch.items);
        picker.targetPackingBay = packBay;

        this.log(`${picker.name} assigned Batch ${batch.id}. Packing target: ${packBay.name}.`, 'picker');

        // Track in process table
        const ptEntry = this.ganttProcessTable.get(batch.id);
        if (ptEntry && ptEntry.startTick === null) {
            ptEntry.startTick = this.ganttTick;
            ptEntry.pickerId = picker.id;
            ptEntry.status = 'Running';
        }

        // Generate Path using A*
        this.recalculatePickerPath(picker);
    }

    _selectOptimalPackingBay(items) {
        // Average X coordinate of items
        const avgX = items.reduce((sum, item) => sum + item.x, 0) / (items.length || 1);
        // Pack Bay A is at X=4, Pack Bay B is at X=12
        const bayA = this.graph.packingBays[0];
        const bayB = this.graph.packingBays[1];

        const distA = Math.abs(avgX - bayA.x);
        const distB = Math.abs(avgX - bayB.x);

        return distA < distB ? bayA : bayB;
    }

    recalculatePickerPath(picker) {
        const batch = picker.assignedBatch;
        if (!batch) return;

        // Filter items that haven't been picked yet
        const unpickedItems = batch.items.filter(item => {
            return !picker.cartContents.some(c => c.id === item.id);
        });

        // Current start point for A*
        const start = { x: picker.x, y: picker.y };
        
        // Find SLA / Courier details
        // Find earliest courier SLA for orders in batch
        let earliestCourier = null;
        for (const order of batch.orders) {
            const courier = this.couriers.find(c => c.assignedOrderIds.includes(order.id));
            if (courier) {
                if (!earliestCourier || courier.slaDeadline < earliestCourier.slaDeadline) {
                    earliestCourier = courier;
                }
            }
        }

        let path;
        if (this.routingMode === 'SSTF') {
            path = this.pathfinder.findPathSSTF(
                start,
                unpickedItems,
                picker.targetPackingBay,
                this.traffic
            );
        } else {
            path = this.pathfinder.findPath(
                start,
                unpickedItems,
                picker.targetPackingBay,
                this.traffic,
                earliestCourier,
                this.currentTime
            );
        }

        if (path) {
            picker.path = path;
            picker.pathIndex = 0;
            
            this.updatePipeline('sstf', `Applied ${this.routingMode}: selected closest items`);
            
            // Log sequence of weights to display in UI
            const sequenceStr = unpickedItems
                .map(item => `${item.name.substr(0, 12)} (${item.weightClass})`)
                .join(' -> ');
            this.log(`${picker.name} calculated path. Sequence: ${sequenceStr || 'Direct to Packing'}`, 'picker');
        } else {
            this.log(`Critical Error: A* Pathfinder failed to compute a path for ${picker.name}!`, 'error');
            // If pathfinding fails (e.g. shelves blocked), route directly to pack bay as exception
            picker.path = [{ x: picker.x, y: picker.y, action: 'start' }, { x: picker.targetPackingBay.x, y: picker.targetPackingBay.y, action: 'move' }];
            picker.pathIndex = 0;
        }
    }

    /**
     * Run a single tick of the warehouse simulation (e.g. representing 1 second of warehouse time)
     */
    tick(deltaTimeMs = 1000) {
        this.currentTime += deltaTimeMs;
        this.ganttTick++;

        // 1. Update Courier countdowns
        this._updateCouriers(deltaTimeMs);

        // 2. Update Pickers along their paths
        this._updatePickers();

        // 3. Spatially calculate traffic density matrix
        this._updateTrafficMap();

        // 4. Update KPI Metrics
        this._updateKPIs(deltaTimeMs);

        // 5. Record Gantt chart scheduling data
        this._ganttRecordTick();

        // Dim active pipeline steps after 4 seconds
        for (const step of ['receive', 'priority', 'preemption', 'sstf']) {
            if (this.pipelineState[step].active && (this.currentTime - this.pipelineState[step].timestamp) > 4000) {
                this.pipelineState[step].active = false;
            }
        }
    }

    /**
     * Record the current scheduling state of each picker for the Gantt chart.
     * Creates segments: 'idle', 'picking', 'packing', 'preempted', 'blocked'
     * Each segment tracks: pickerId, type, batchId, priority, startTick, endTick
     */
    _ganttRecordTick() {
        for (const picker of this.pickers) {
            let segType;
            let batchId = null;
            let priority = 0;

            if (picker.status === 'Idle') {
                segType = 'idle';
            } else if (picker.status === 'Picking') {
                if (picker.blockedTicks > 0) {
                    segType = 'blocked';
                } else {
                    segType = 'picking';
                }
                batchId = picker.assignedBatch ? picker.assignedBatch.id : null;
                priority = picker.assignedBatch ? (picker.assignedBatch.priority || 1) : 1;
            } else if (picker.status === 'Packing') {
                segType = 'packing';
                batchId = picker.assignedBatch ? picker.assignedBatch.id : null;
                priority = picker.assignedBatch ? (picker.assignedBatch.priority || 1) : 1;
            } else {
                segType = 'idle';
            }

            // Accumulate active execution ticks for the batch (ignoring blocked/idle ticks)
            if (segType === 'picking' || segType === 'packing') {
                if (picker.assignedBatch) {
                    const ptEntry = this.ganttProcessTable.get(picker.assignedBatch.id);
                    if (ptEntry) {
                        ptEntry.executionTicks = (ptEntry.executionTicks || 0) + 1;
                    }
                }
            }

            const currentSeg = this._ganttCurrentSegment[picker.id];
            const wasResumed = this._ganttResumedFlag[picker.id];
            if (wasResumed) this._ganttResumedFlag[picker.id] = false;

            // Check if state changed (or if a resume event forces a new segment)
            if (!currentSeg || currentSeg.type !== segType || currentSeg.batchId !== batchId || wasResumed) {
                // Finalize current segment
                if (currentSeg) {
                    currentSeg.endTick = this.ganttTick - 1;
                    this.ganttHistory.push({ ...currentSeg });
                }
                // Start new segment
                this._ganttCurrentSegment[picker.id] = {
                    pickerId: picker.id,
                    pickerName: picker.name,
                    pickerColor: picker.color,
                    type: segType,
                    batchId: batchId,
                    priority: priority,
                    startTick: this.ganttTick,
                    endTick: this.ganttTick
                };
            } else {
                // Same state continues, extend end tick
                currentSeg.endTick = this.ganttTick;
            }
        }

        // Cap gantt history to last 600 entries to prevent memory leak
        if (this.ganttHistory.length > 600) {
            this.ganttHistory = this.ganttHistory.slice(-400);
        }
    }

    /**
     * Get all Gantt segments (finalized + current) for rendering
     */
    getGanttData() {
        const allSegments = [...this.ganttHistory];
        // Also include current in-progress segments
        for (const pickerId of Object.keys(this._ganttCurrentSegment)) {
            const seg = this._ganttCurrentSegment[pickerId];
            if (seg) {
                allSegments.push({ ...seg, endTick: this.ganttTick });
            }
        }
        return allSegments;
    }

    _updateCouriers(deltaTimeMs) {
        for (const courier of this.couriers) {
            if (courier.status === 'EnRoute') {
                courier.etaSeconds = Math.max(0, courier.etaSeconds - (deltaTimeMs / 1000));
                if (courier.etaSeconds === 0) {
                    courier.status = 'Arrived';
                    this.log(`Courier ${courier.id} has arrived at Storefront Loading Bay ${courier.bayNumber}!`, 'courier');
                    
                    // Check if assigned orders are staged
                    for (const orderId of courier.assignedOrderIds) {
                        const order = this.orders.find(o => o.id === orderId);
                        if (order && order.status !== 'Staged' && order.status !== 'Completed') {
                            // FAILED SLA
                            order.status = 'FailedSLA';
                            this.kpis.totalOrdersFailedSLA++;
                            this.log(`SLA SLA Violation: Courier arrived before Order ${orderId} was staged!`, 'error');
                        }
                    }
                }
            }
        }
    }

    _updateTrafficMap() {
        // Reset density to zero
        for (let x = 0; x < simGridWidth; x++) {
            for (let y = 0; y < simGridHeight; y++) {
                this.traffic[x][y] = 0;
            }
        }

        // Register each picker's location
        for (const picker of this.pickers) {
            if (picker.status !== 'Idle') {
                this.traffic[picker.x][picker.y]++;
            }
        }
    }

    _updatePickers() {
        for (const picker of this.pickers) {
            if (picker.status === 'Idle' || picker.status === 'Packing') continue;

            const path = picker.path;
            if (!path || picker.pathIndex >= path.length) {
                // Edge case: Picker completed path but is still marked busy
                this._completePickerBatch(picker);
                continue;
            }

            const currentStep = path[picker.pathIndex];
            
            // Check if step is a PICK action
            if (currentStep.action.startsWith('pick:')) {
                const skuId = currentStep.skuId;
                const sku = this.skus.find(s => s.id === skuId);

                if (!sku) {
                    this.log(`Error: SKU ${skuId} not found in inventory.`, 'error');
                    picker.pathIndex++;
                    continue;
                }

                // Acquire Mutex Lock on the SKU slot
                const isLocked = this.skuLocks.get(skuId);
                
                if (isLocked) {
                    // Contention! Lock is currently held by another picker
                    picker.blockedTicks++;
                    this.kpis.lockContentionCount++;
                    if (picker.blockedTicks % 3 === 1) { // Throttle logs
                        this.log(`Lock Contention: ${picker.name} blocked at (${sku.x}, ${sku.y}). ${skuId} is locked.`, 'warning');
                    }
                    continue; // Stop and wait at current position
                }

                // Mutex Lock acquired!
                this.skuLocks.set(skuId, true);
                this.kpis.locksAcquired++;
                picker.blockedTicks = 0;

                // Critical section: execute picking transaction
                if (sku.stock > 0) {
                    sku.stock--; // Decrement stock atomically
                    this.skuLocks.set(skuId, false); // Instantly release lock

                    picker.cartContents.push({
                        id: sku.id,
                        name: sku.name,
                        weightClass: sku.weightClass,
                        symbol: sku.symbol,
                        x: sku.x,
                        y: sku.y
                    });

                    picker.binWeight += (sku.weightClass === WEIGHT_CLASSES_VAL.HEAVY ? 5 : 
                                         sku.weightClass === WEIGHT_CLASSES_VAL.LIGHT ? 1 : 0.2);

                    this.log(`${picker.name} acquired lock on ${skuId}, decremented stock to ${sku.stock}, and picked ${sku.symbol}.`, 'success');

                    // Check for structural damage (crush rate)
                    // If we just picked a Heavy item, but there are already Fragile items in the cart
                    const fragileItems = picker.cartContents.filter(item => item.weightClass === WEIGHT_CLASSES_VAL.FRAGILE);
                    if (sku.weightClass === WEIGHT_CLASSES_VAL.HEAVY && fragileItems.length > 0) {
                        this.kpis.productDamageCount += fragileItems.length;
                        this.log(`⚠️ Product Damage: ${fragileItems.length} fragile item(s) crushed under Heavy ${sku.symbol}! Sequence safety violated.`, 'error');
                    }

                    picker.pathIndex++; // Advance to next path step
                } else {
                    // Cache Exception: Stock depleted (value is 0)
                    this.skuLocks.set(skuId, false); // Release lock immediately
                    this.log(`Cache Exception: ${picker.name} found ${skuId} out of stock. Triggering A* re-path...`, 'warning');

                    // Find alternative shelf with same item name or mark shorted
                    const alternativeSKU = this.skus.find(s => s.name === sku.name && s.stock > 0 && s.id !== sku.id);
                    
                    if (alternativeSKU) {
                        // Swap item ID in batch items to the alternative SKU
                        const batch = picker.assignedBatch;
                        const itemIndex = batch.items.findIndex(item => item.id === sku.id);
                        if (itemIndex !== -1) {
                            batch.items[itemIndex] = {
                                ...batch.items[itemIndex],
                                id: alternativeSKU.id,
                                x: alternativeSKU.x,
                                y: alternativeSKU.y
                            };
                            this.log(`Re-routing: Alternative shelf found at (${alternativeSKU.x}, ${alternativeSKU.y}).`, 'info');
                        }
                    } else {
                        // No alternatives, remove item from batch and notify
                        this.log(`Shortage: ${sku.name} is completely out of stock. Order will be processed shorted.`, 'error');
                        const batch = picker.assignedBatch;
                        batch.items = batch.items.filter(item => item.id !== sku.id);
                    }

                    // Force immediate A* recalculation from current spot
                    this.recalculatePickerPath(picker);
                }
            } else {
                // Step is a MOVE action
                // Move picker to the step's coordinate
                picker.x = currentStep.x;
                picker.y = currentStep.y;
                picker.totalDistanceWalked++;
                this.actualPickerDistance++;

                picker.pathIndex++;

                // If path completed, route to consolidated packing process
                if (picker.pathIndex >= path.length) {
                    this._completePickerBatch(picker);
                }
            }
        }
        
        // Update active movement positions in the pipeline
        const activeCoords = this.pickers
            .filter(p => p.status !== 'Idle')
            .map(p => `${p.name.split(' ')[1][0]}:(${p.x},${p.y})`)
            .join(' ');
        if (activeCoords) {
            this.updatePipeline('move', `Routing: ${activeCoords}`);
        } else {
            this.updatePipeline('move', 'All pickers waiting / idle', false);
        }
    }

    _completePickerBatch(picker) {
        const batch = picker.assignedBatch;
        if (!batch) return;

        picker.status = 'Packing';
        
        // Simulate consolidation time (e.g. 3 ticks of packing)
        picker.currentTaskTime = 3; 

        // Add static baseline distance for KPIs
        // Static baseline distance represents picking the same batch item-by-item without batching and sorting heuristics.
        // It's generally much longer. Let's add a baseline estimate (e.g., 2.2x simple distance)
        const itemCoordinates = batch.items.map(item => ({ x: item.x, y: item.y }));
        let baseline = 0;
        let lastPt = { x: 0, y: 0 };
        for (const pt of itemCoordinates) {
            baseline += Math.abs(lastPt.x - pt.x) + Math.abs(lastPt.y - pt.y);
            lastPt = pt;
        }
        const packingBay = picker.targetPackingBay || this.graph.packingBays[0];
        baseline += Math.abs(lastPt.x - packingBay.x) + Math.abs(lastPt.y - packingBay.y);
        
        this.staticBaselineDistance += baseline;

        // Track packing phase in process table
        const ptEntry = this.ganttProcessTable.get(batch.id);
        if (ptEntry) {
            ptEntry.status = 'Packing';
        }
        
        const packingBayName = packingBay ? packingBay.name : 'Packing Bay';
        this.log(`${picker.name} finished picking. Consolidating and packing Batch ${batch.id} at ${packingBayName}...`, 'picker');
        
        // Note: Do NOT call _tickPacking here. Packing is ticked via _updatePickers on subsequent ticks.
        // Calling it here would double-decrement currentTaskTime on the first tick.
    }

    _tickPacking(picker) {
        if (picker.status === 'Packing') {
            picker.currentTaskTime--;
            if (picker.currentTaskTime <= 0) {
                // Reset picker
                const finishedBatch = picker.assignedBatch;
                picker.assignedBatch = null;
                picker.path = null;
                picker.pathIndex = 0;
                picker.binWeight = 0;
                picker.cartContents = [];

                if (finishedBatch) {
                    // Update orders in batch to staged/consolidated
                    for (const order of finishedBatch.orders) {
                        const found = this.orders.find(o => o.id === order.id);
                        if (found) {
                            // If it already failed SLA, keep that status
                            if (found.status !== 'FailedSLA') {
                                found.status = 'Staged';
                                this.kpis.totalOrdersFulfilled++;
                                this.log(`Success: Order ${found.id} staged at ${picker.targetPackingBay.name}!`, 'success');
                                
                                // Complete courier status if all orders staged
                                const courier = this.couriers.find(c => c.assignedOrderIds.includes(found.id));
                                if (courier && courier.status === 'Arrived') {
                                    courier.status = 'Departed';
                                    this.log(`Courier ${courier.id} loaded and departed.`, 'courier');
                                }
                            }
                        }
                    }
                    
                    // Complete batch status
                    finishedBatch.status = 'Completed';

                    // Track completion in process table
                    const ptEntry = this.ganttProcessTable.get(finishedBatch.id);
                    if (ptEntry) {
                        ptEntry.completionTick = this.ganttTick;
                        ptEntry.status = 'Completed';
                    }
                }
                
                if (picker.suspendedBatch) {
                    // Resume suspended task (context switch)
                    this.log(`⚡ Context Switch: ${picker.name} resuming suspended Batch ${picker.suspendedBatch.id}.`, 'success');
                    
                    // Record resume event for Gantt chart
                    this.ganttResumes.push({
                        tick: this.ganttTick,
                        pickerId: picker.id,
                        batchId: picker.suspendedBatch.id,
                        resumedFrom: 'preemption'
                    });

                    // Set status of resumed batch back to Running in process table
                    const resumedPtEntry = this.ganttProcessTable.get(picker.suspendedBatch.id);
                    if (resumedPtEntry) {
                        resumedPtEntry.status = 'Running';
                    }

                    picker.assignedBatch = picker.suspendedBatch;
                    picker.cartContents = picker.suspendedCart;
                    picker.suspendedBatch = null;
                    picker.suspendedCart = null;
                    
                    // Recalculate bin weight of restored items
                    picker.binWeight = picker.cartContents.reduce((weight, item) => {
                        return weight + (item.weightClass === WEIGHT_CLASSES_VAL.HEAVY ? 5 : 
                                         item.weightClass === WEIGHT_CLASSES_VAL.LIGHT ? 1 : 0.2);
                    }, 0);
                    
                    picker.status = 'Picking';
                    this._ganttResumedFlag[picker.id] = true; // Force new Gantt segment
                    this.recalculatePickerPath(picker);
                } else {
                    picker.status = 'Idle';
                    this.log(`${picker.name} finished packing and returned to staging zone.`, 'picker');
                    
                    // Teleport to staging to ready for next batch
                    picker.x = 0;
                    picker.y = 0;

                    // Look for remaining batches
                    this._assignBatchesToIdlePickers();
                }
            }
        }
    }

    _updateKPIs(deltaTimeMs) {
        // Average pick cycle time (simulation time elapsed since start divided by orders fulfilled)
        const elapsedMin = (this.currentTime - this.startTime) / 60000;
        this.kpis.ordersProcessedPerHour = elapsedMin > 0 ? 
            Math.round((this.kpis.totalOrdersFulfilled / elapsedMin) * 60) : 0;

        // Walking distance reduction
        // Baseline walking vs actual walking
        if (this.staticBaselineDistance > 0) {
            const reduction = ((this.staticBaselineDistance - this.actualPickerDistance) / this.staticBaselineDistance) * 100;
            this.kpis.walkingDistanceReduction = Math.max(0, Math.round(reduction));
        } else {
            this.kpis.walkingDistanceReduction = 15; // default starting baseline estimation
        }

        // Crush Rate
        // Total fragile items processed in fulfilled orders vs damaged items
        const totalFragilePicked = this.pickers.reduce((sum, p) => 
            sum + p.cartContents.filter(item => item.weightClass === WEIGHT_CLASSES_VAL.FRAGILE).length, 0)
            + this.kpis.totalOrdersFulfilled * 1.2; // Estimation of past items
        
        this.kpis.crushRate = totalFragilePicked > 0 ? 
            Math.round((this.kpis.productDamageCount / totalFragilePicked) * 100) : 0;

        // SLA compliance percentage
        const totalConcludedOrders = this.kpis.totalOrdersFulfilled + this.kpis.totalOrdersFailedSLA;
        this.kpis.slaCompliancePercent = totalConcludedOrders > 0 ? 
            Math.round((this.kpis.totalOrdersFulfilled / totalConcludedOrders) * 100) : 100;

        // Average Pick-Cycle Time (mocked scaling based on performance)
        this.kpis.averagePickCycleTimeMs = this.kpis.totalOrdersFulfilled > 0 ? 
            Math.round((this.actualPickerDistance * 1000) / this.kpis.totalOrdersFulfilled) : 8500;

        // Set raw distance walked
        this.kpis.cumulativeWalkingDistance = this.actualPickerDistance;

        // Check if pickers in packing need to be ticked
        for (const picker of this.pickers) {
            if (picker.status === 'Packing') {
                this._tickPacking(picker);
            }
        }
    }

    // Manual triggers
    manuallyRestockAll() {
        for (const sku of this.skus) {
            sku.stock = sku.maxStock;
        }
        this.log(`Inventory restocked: All SKU stock counts set to maximum (${12}).`, 'success');
    }

    manuallyDepleteStock(skuId) {
        const sku = this.skus.find(s => s.id === skuId);
        if (sku) {
            sku.stock = 0;
            this.log(`Manual Depletion: stock of ${sku.name} (${skuId}) set to 0.`, 'warning');
        }
    }

    manuallyInjectCongestion(x, y, density = 5) {
        if (this.graph.isPath(x, y)) {
            this.traffic[x][y] = density;
            this.log(`Manual Congestion: Traffic density at (${x}, ${y}) forced to ${density}.`, 'warning');
            
            // Recalculate paths for any pickers that are routing and will hit this congestion
            for (const picker of this.pickers) {
                if (picker.status === 'Picking') {
                    this.recalculatePickerPath(picker);
                }
            }
        }
    }

    clearCongestion() {
        for (let x = 0; x < simGridWidth; x++) {
            for (let y = 0; y < simGridHeight; y++) {
                this.traffic[x][y] = 0;
            }
        }
        this.log(`Traffic congestion maps cleared warehouse-wide.`, 'success');
        
        // Recalculate paths to adapt to empty paths
        for (const picker of this.pickers) {
            if (picker.status === 'Picking') {
                this.recalculatePickerPath(picker);
            }
        }
    }
}

// Export modules for Node testing
if (typeof module !== 'undefined') {
    module.exports = Simulation;
}
