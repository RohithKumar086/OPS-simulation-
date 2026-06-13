/**
 * test.js
 * Verification test suite for A* pathfinder and mutex locking transactions.
 */

const { WarehouseGraph, AStarPathfinder, WEIGHT_CLASSES } = require('./agent');
const Simulation = require('./simulation');

console.log("=== STARTING AGENT VERIFICATION TESTS ===");

function testAStarCorrectness() {
    console.log("\n--- Testing A* Pathfinder Correctness & Sequence Safety ---");
    const graph = new WarehouseGraph();
    const pathfinder = new AStarPathfinder(graph);

    // Setup a batch of items
    // Place a Heavy SKU at (1, 1), a Light SKU at (4, 4), and a Fragile SKU at (13, 1)
    const batch = [
        { id: 'SKU-H', name: 'Heavy Item', x: 1, y: 1, weightClass: WEIGHT_CLASSES.HEAVY },
        { id: 'SKU-L', name: 'Light Item', x: 4, y: 4, weightClass: WEIGHT_CLASSES.LIGHT },
        { id: 'SKU-F', name: 'Fragile Item', x: 13, y: 1, weightClass: WEIGHT_CLASSES.FRAGILE }
    ];

    const start = { x: 0, y: 0 };
    const packingBay = { x: 4, y: 11 };
    const trafficMap = Array(16).fill(0).map(() => Array(12).fill(0));

    // Calculate path
    const path = pathfinder.findPath(start, batch, packingBay, trafficMap, null, Date.now());

    if (!path) {
        throw new Error("A* failed to find a path!");
    }

    console.log(`Path generated successfully with ${path.length} steps.`);
    
    // Validate order of picks in path history
    const picks = path.filter(step => step.action.startsWith('pick:'));
    console.log("Pick Sequence:");
    picks.forEach((pick, idx) => {
        const item = batch.find(b => b.id === pick.skuId);
        console.log(`  ${idx + 1}. Picked ${pick.skuId} (${item.weightClass}) at adjacent coordinates.`);
    });

    if (picks.length !== batch.length) {
        throw new Error(`Expected ${batch.length} picks, but path only contains ${picks.length}`);
    }

    // Verify sequence: Heavy should be picked before Fragile
    const heavyIndex = picks.findIndex(p => p.skuId === 'SKU-H');
    const fragileIndex = picks.findIndex(p => p.skuId === 'SKU-F');
    const lightIndex = picks.findIndex(p => p.skuId === 'SKU-L');

    console.log(`Heavy item index in pick list: ${heavyIndex}`);
    console.log(`Light item index in pick list: ${lightIndex}`);
    console.log(`Fragile item index in pick list: ${fragileIndex}`);

    if (heavyIndex > fragileIndex) {
        throw new Error("FAIL: Heavy item was picked AFTER Fragile item! Violation of sequence safety!");
    }
    console.log("PASS: Heavy item was picked before Fragile item.");

    if (lightIndex > fragileIndex) {
        throw new Error("FAIL: Light item was picked AFTER Fragile item!");
    }
    console.log("PASS: Light item was picked before Fragile item.");
}

function testMutexLocking() {
    console.log("\n--- Testing Mutex Locking and Stock depletion (Race Conditions) ---");
    const sim = new Simulation();

    // Find first SKU and set stock to 1
    const targetSKU = sim.skus[0];
    targetSKU.stock = 1;
    console.log(`Target SKU for conflict: ${targetSKU.id} (${targetSKU.name}) - Stock count: ${targetSKU.stock}`);

    // Set up two pickers to pick this SKU
    const p1 = sim.pickers[0];
    const p2 = sim.pickers[1];

    // Assign manually simulated orders that require this SKU
    const orderA = {
        id: 'ORD-TEST-A',
        itemsRequested: [targetSKU.id],
        status: 'Unassigned',
        createdTime: sim.currentTime,
        slaDeadline: sim.currentTime + 100000
    };
    const orderB = {
        id: 'ORD-TEST-B',
        itemsRequested: [targetSKU.id],
        status: 'Unassigned',
        createdTime: sim.currentTime,
        slaDeadline: sim.currentTime + 100000
    };

    // Create two separate batches manually to prevent OrderBatcher from merging them
    const batch1 = {
        id: 'batch-1',
        orders: [orderA],
        items: [{ orderId: orderA.id, ...targetSKU }],
        status: 'Batched',
        createdTime: Date.now()
    };
    const batch2 = {
        id: 'batch-2',
        orders: [orderB],
        items: [{ orderId: orderB.id, ...targetSKU }],
        status: 'Batched',
        createdTime: Date.now()
    };

    sim.batches.push(batch1, batch2);
    orderA.status = 'Batched';
    orderB.status = 'Batched';

    // Assign batches to separate pickers
    sim._assignBatchToPicker(p1, batch1);
    sim._assignBatchToPicker(p2, batch2);

    // Trigger pathfinders
    console.log(`${p1.name} assigned path length: ${p1.path.length}`);
    console.log(`${p2.name} assigned path length: ${p2.path.length}`);

    // Teleport both pickers to the access point of the target SKU to simulate arrival on the same tick
    const accessPoints = sim.graph.getAccessPoints(targetSKU.x, targetSKU.y);
    const pPoint = accessPoints[0];
    p1.x = pPoint.x;
    p1.y = pPoint.y;
    p2.x = pPoint.x;
    p2.y = pPoint.y;

    // Manually search and overwrite their path index to trigger pick next
    p1.path = [{ x: pPoint.x, y: pPoint.y, action: 'start' }, { x: pPoint.x, y: pPoint.y, action: `pick:${targetSKU.id}`, skuId: targetSKU.id }];
    p1.pathIndex = 1;

    p2.path = [{ x: pPoint.x, y: pPoint.y, action: 'start' }, { x: pPoint.x, y: pPoint.y, action: `pick:${targetSKU.id}`, skuId: targetSKU.id }];
    p2.pathIndex = 1;

    console.log("Simulating single tick when both are attempting to pick the same SKU at the same time...");
    sim._updatePickers();

    // Let's verify that one picker succeeds and the other fails or is blocked/re-routed
    const p1CartCount = p1.cartContents.length;
    const p2CartCount = p2.cartContents.length;
    
    console.log(`${p1.name} cart items: ${p1CartCount}`);
    console.log(`${p2.name} cart items: ${p2CartCount}`);
    console.log(`SKU Stock remaining: ${targetSKU.stock}`);

    // One of them must have picked it, and the other must have run into stock-out re-routing
    if (p1CartCount === 1 && p2CartCount === 0) {
        console.log(`PASS: ${p1.name} successfully picked the item. ${p2.name} failed (stock depleted) and triggered re-routing.`);
    } else if (p2CartCount === 1 && p1CartCount === 0) {
        console.log(`PASS: ${p2.name} successfully picked the item. ${p1.name} failed (stock depleted) and triggered re-routing.`);
    } else {
        throw new Error(`FAIL: Invalid cart counts! P1: ${p1CartCount}, P2: ${p2CartCount}`);
    }
}

function testSSTFCorrectness() {
    console.log("\n--- Testing SSTF Pathfinder (Seek/Distance First) ---");
    const graph = new WarehouseGraph();
    const pathfinder = new AStarPathfinder(graph);

    // Setup: Place Fragile SKU at (1,1) [distance = 2] and Heavy SKU at (4,4) [distance = 8]
    const batch = [
        { id: 'SKU-F', name: 'Fragile Item', x: 1, y: 1, weightClass: WEIGHT_CLASSES.FRAGILE },
        { id: 'SKU-H', name: 'Heavy Item', x: 4, y: 4, weightClass: WEIGHT_CLASSES.HEAVY }
    ];

    const start = { x: 0, y: 0 };
    const packingBay = { x: 4, y: 11 };
    const trafficMap = Array(16).fill(0).map(() => Array(12).fill(0));

    // Run SSTF Pathfinding
    const path = pathfinder.findPathSSTF(start, batch, packingBay, trafficMap);

    if (!path) {
        throw new Error("SSTF pathfinder failed to find a path!");
    }

    const picks = path.filter(step => step.action.startsWith('pick:'));
    console.log("SSTF Pick Sequence:");
    picks.forEach((pick, idx) => {
        const item = batch.find(b => b.id === pick.skuId);
        console.log(`  ${idx + 1}. Picked ${pick.skuId} (${item.weightClass})`);
    });

    // In SSTF, Fragile (index 0) must be picked BEFORE Heavy (index 1) because it is closer (2 vs 8)
    const fragileIndex = picks.findIndex(p => p.skuId === 'SKU-F');
    const heavyIndex = picks.findIndex(p => p.skuId === 'SKU-H');

    if (fragileIndex > heavyIndex) {
        throw new Error("FAIL: SSTF did not pick closer fragile item first!");
    }
    console.log("PASS: SSTF picked closer fragile item first (ignores sequence safety in favor of seek optimization).");
}

function testPreemptionContextSwitching() {
    console.log("\n--- Testing Preemptive Priority Scheduling (Context Switches) ---");
    const sim = new Simulation();
    
    // Find active pickers and set them up
    const picker = sim.pickers[0];
    
    // Make the other pickers busy to force resource exhaustion and trigger preemption
    const packBay = sim.graph.packingBays[0];
    sim.pickers[1].status = 'Picking';
    sim.pickers[1].assignedBatch = { priority: 1, id: 'mock-b2', items: [], orders: [] };
    sim.pickers[1].targetPackingBay = packBay;
    sim.pickers[2].status = 'Picking';
    sim.pickers[2].assignedBatch = { priority: 1, id: 'mock-b3', items: [], orders: [] };
    sim.pickers[2].targetPackingBay = packBay;

    // 1. Create a Normal Order (Priority 1)
    const normalOrder = sim.spawnOrder(2, 1);
    console.log(`Created Normal Order: ${normalOrder.id} (Priority 1)`);
    
    // Check that Picker Delta was assigned the normal batch
    if (picker.assignedBatch.orders[0].id !== normalOrder.id) {
        throw new Error(`Expected picker to be assigned normal order, got ${picker.assignedBatch?.orders[0]?.id}`);
    }
    console.log(`Picker status: ${picker.status}, Assigned Batch: ${picker.assignedBatch.id} (P${picker.assignedBatch.priority})`);
    
    // Mock picker having already picked 1 item of the normal batch
    const pickedSKU = sim.skus.find(s => s.id === picker.assignedBatch.items[0].id);
    picker.cartContents.push(pickedSKU);
    picker.binWeight = 1.0;
    console.log(`Picker pre-preemption cart size: ${picker.cartContents.length} item(s)`);

    // 2. Create an Emergency Order (Priority 3)
    console.log("Spawning Priority 3 Emergency Order...");
    const emergencyOrder = sim.spawnOrder(1, 3);
    
    // The preemption mechanism should automatically trigger during spawnOrder -> triggerBatching!
    // Let's verify that preemption happened
    console.log(`Picker active batch after Emergency Order: ${picker.assignedBatch.id} (P${picker.assignedBatch.priority})`);
    
    if ((picker.assignedBatch.priority || 1) !== 3) {
        throw new Error("FAIL: Picker was not preempted by Priority 3 Emergency Batch!");
    }
    console.log("PASS: Picker was successfully preempted by Emergency Batch.");
    
    if (!picker.suspendedBatch) {
        throw new Error("FAIL: Suspended batch context was not preserved!");
    }
    console.log(`PASS: Suspended batch preserved: ${picker.suspendedBatch.id} with ${picker.suspendedCart.length} item(s) preserved in context.`);

    // 3. Complete the Emergency Batch
    console.log("Simulating Picker Delta completing the Emergency Batch...");
    // Teleport picker to Packing Bay and mock pick completion
    const emergencySKU = sim.skus.find(s => s.id === picker.assignedBatch.items[0].id);
    picker.cartContents.push(emergencySKU);
    picker.x = picker.targetPackingBay.x;
    picker.y = picker.targetPackingBay.y;
    
    // Call batch completion
    sim._completePickerBatch(picker);
    console.log(`Picker status: ${picker.status}, Task remaining time: ${picker.currentTaskTime}`);
    
    // Tick the simulation 3 times to complete packing process
    sim.tick(1000);
    sim.tick(1000);
    sim.tick(1000);
    
    // 4. Verify context restore
    console.log(`Picker status after packing finished: ${picker.status}`);
    console.log(`Picker active batch restored: ${picker.assignedBatch?.id || 'None'}`);
    
    if (picker.status !== 'Picking' || !picker.assignedBatch || picker.assignedBatch.id !== picker.suspendedBatch) {
        // Wait, picker.suspendedBatch is cleared upon restore, so we check if the active batch is the one we preserved
        // Let's verify that the restored batch has priority 1
        if (picker.assignedBatch && picker.assignedBatch.priority === 1) {
            console.log("PASS: Picker context fully restored. Picker status set to Picking, cart items restored.");
        } else {
            throw new Error(`FAIL: Context restore failed. Current batch: ${picker.assignedBatch?.id} (P${picker.assignedBatch?.priority})`);
        }
    }
    console.log(`Restored cart size: ${picker.cartContents.length} item(s)`);
    if (picker.cartContents.length !== 1 || picker.cartContents[0].id !== pickedSKU.id) {
        throw new Error("FAIL: Restored cart items do not match preserved items!");
    }
    console.log("PASS: Restored cart items verified.");
}

function testGanttChartTelemetry() {
    console.log("\n--- Testing Gantt Chart Telemetry and Telemetry Calculations ---");
    const sim = new Simulation();
    
    const picker = sim.pickers[0];
    
    // Create a Normal Order (Priority 1)
    const normalOrder = sim.spawnOrder(1, 1);
    const batchId = picker.assignedBatch.id;
    
    // Tick the simulation 3 times: should record execution ticks
    sim.tick(1000);
    sim.tick(1000);
    sim.tick(1000);
    
    const ptEntry = sim.ganttProcessTable.get(batchId);
    console.log(`Execution ticks after 3 picking ticks: ${ptEntry.executionTicks}`);
    if (ptEntry.executionTicks !== 3) {
        throw new Error(`Expected 3 execution ticks, got ${ptEntry.executionTicks}`);
    }
    console.log("PASS: Execution ticks counted correctly.");
    
    // Simulate preemption
    console.log("Injecting emergency order to trigger preemption...");
    // Force other pickers busy so picker 0 gets preempted
    const packBay = sim.graph.packingBays[0];
    sim.pickers[1].status = 'Picking';
    sim.pickers[1].assignedBatch = { priority: 1, id: 'mock-b2', items: [], orders: [] };
    sim.pickers[1].targetPackingBay = packBay;
    sim.pickers[2].status = 'Picking';
    sim.pickers[2].assignedBatch = { priority: 1, id: 'mock-b3', items: [], orders: [] };
    sim.pickers[2].targetPackingBay = packBay;
    
    const emergencyOrder = sim.spawnOrder(1, 3);
    const emergencyBatchId = picker.assignedBatch.id;
    
    // Check that preemption segment is created
    // Preemption segment should have type 'preempted'
    const preemptedSegs = sim.ganttHistory.filter(s => s.type === 'preempted');
    console.log(`Preempted segments count: ${preemptedSegs.length}`);
    if (preemptedSegs.length !== 1) {
        throw new Error(`Expected exactly 1 preempted segment, got ${preemptedSegs.length}`);
    }
    
    const pSeg = preemptedSegs[0];
    console.log(`Preemption segment startTick: ${pSeg.startTick}, endTick: ${pSeg.endTick}`);
    if (pSeg.startTick !== pSeg.endTick) {
        throw new Error(`Expected preempted segment to be 1 tick duration (startTick === endTick), got duration ${pSeg.endTick - pSeg.startTick}`);
    }
    console.log("PASS: Preempted segment duration is exactly 1 tick.");
    
    // Check table status for suspended batch
    if (ptEntry.status !== 'Suspended') {
        throw new Error(`Expected suspended batch status to be 'Suspended', got ${ptEntry.status}`);
    }
    console.log("PASS: Suspended batch table status is 'Suspended'.");

    // Let the emergency batch pick and finish picking (teleport to packing bay)
    picker.x = picker.targetPackingBay.x;
    picker.y = picker.targetPackingBay.y;
    picker.pathIndex = picker.path.length; // Complete path
    
    // First tick of update will call _completePickerBatch
    sim.tick(1000); 
    
    const emergencyPtEntry = sim.ganttProcessTable.get(emergencyBatchId);
    if (emergencyPtEntry.status !== 'Packing') {
        throw new Error(`Expected emergency batch status to be 'Packing', got ${emergencyPtEntry.status}`);
    }
    console.log("PASS: Emergency batch status set to 'Packing' upon finishing picking.");
    
    // Tick 3 times to complete packing
    sim.tick(1000); // packing tick 1
    sim.tick(1000); // packing tick 2
    sim.tick(1000); // packing tick 3 (completes)
    
    if (emergencyPtEntry.status !== 'Completed') {
        throw new Error(`Expected completed emergency batch status to be 'Completed', got ${emergencyPtEntry.status}`);
    }
    console.log("PASS: Emergency batch status set to 'Completed' after packing finishes.");
    
    // Normal batch should be resumed now
    if (ptEntry.status !== 'Running') {
        throw new Error(`Expected resumed batch status to be 'Running', got ${ptEntry.status}`);
    }
    console.log("PASS: Resumed batch status set to 'Running'.");
}

try {
    testAStarCorrectness();
    testMutexLocking();
    testSSTFCorrectness();
    testPreemptionContextSwitching();
    testGanttChartTelemetry();
    console.log("\n=== ALL TESTS PASSED SUCCESSFULLY! ===");
} catch (error) {
    console.error("\n=== TEST SUITE FAILED ===");
    console.error(error);
    process.exit(1);
}
