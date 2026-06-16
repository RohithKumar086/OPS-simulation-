/**
 * app.js
 * UI controller, Canvas renderer, and Event listener bindings.
 */

// Initialize Simulation
const sim = new Simulation();
let isPaused = false;
let tickIntervalMs = 1000;
let simTimer = null;

// DOM Elements
const canvas = document.getElementById('warehouse-canvas');
const ctx = canvas.getContext('2d');
const btnPause = document.getElementById('btn-pause');
const btn1x = document.getElementById('btn-speed-1x');
const btn2x = document.getElementById('btn-speed-2x');
const btn5x = document.getElementById('btn-speed-5x');
const simClockEl = document.getElementById('sim-clock');

// KPI elements
const valThroughput = document.getElementById('val-throughput');
const valCycleTime = document.getElementById('val-cycletime');
const valDistance = document.getElementById('val-distance');
const valIntegrity = document.getElementById('val-integrity');
const valSLA = document.getElementById('val-sla');

// Sidebars
const pickerListEl = document.getElementById('picker-list');
const orderListEl = document.getElementById('order-list');
const courierListEl = document.getElementById('courier-list');
const countPickersEl = document.getElementById('count-pickers');
const countOrdersEl = document.getElementById('count-orders');
const countCouriersEl = document.getElementById('count-couriers');
const consoleLogsEl = document.getElementById('console-logs');

// Sliders
const sliderAlpha = document.getElementById('slider-alpha');
const sliderBeta = document.getElementById('slider-beta');
const sliderGamma = document.getElementById('slider-gamma');
const sliderDelta = document.getElementById('slider-delta');

const labelAlpha = document.getElementById('label-alpha');
const labelBeta = document.getElementById('label-beta');
const labelGamma = document.getElementById('label-gamma');
const labelDelta = document.getElementById('label-delta');

// Buttons & Dropdowns
const btnSpawnOrder = document.getElementById('btn-spawn-order');
const btnSpawnEmergency = document.getElementById('btn-spawn-emergency');
const btnRaceCondition = document.getElementById('btn-race-condition');
const btnRestock = document.getElementById('btn-restock');
const btnClearTraffic = document.getElementById('btn-clear-traffic');
const selectRoutingMode = document.getElementById('select-routing-mode');

// --- Canvas Drawing Constants ---
const CELL_SIZE = 50; // Each cell is 50x50 pixels

// Visual coordinates for smooth LERP animation
const pickerVisuals = {};
sim.pickers.forEach(p => {
    pickerVisuals[p.id] = {
        x: p.x * CELL_SIZE + CELL_SIZE/2,
        y: p.y * CELL_SIZE + CELL_SIZE/2
    };
});

// --- Heuristic Slider Normalization ---
// When the user adjusts a slider, we normalize the weights so they sum to 1.0
const sliders = [
    { el: sliderAlpha, key: 'alpha', label: labelAlpha },
    { el: sliderBeta, key: 'beta', label: labelBeta },
    { el: sliderGamma, key: 'gamma', label: labelGamma },
    { el: sliderDelta, key: 'delta', label: labelDelta }
];

sliders.forEach(slider => {
    slider.el.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        HEURISTIC_WEIGHTS[slider.key] = val;
        
        // Normalize other values so sum = 1.0
        const totalOtherKeys = sliders.filter(s => s.key !== slider.key);
        const sumOthers = totalOtherKeys.reduce((sum, s) => sum + HEURISTIC_WEIGHTS[s.key], 0);
        const targetOthers = 1.0 - val;

        if (sumOthers > 0) {
            totalOtherKeys.forEach(s => {
                HEURISTIC_WEIGHTS[s.key] = (HEURISTIC_WEIGHTS[s.key] / sumOthers) * targetOthers;
                s.el.value = HEURISTIC_WEIGHTS[s.key];
            });
        } else {
            // If others are all 0, distribute evenly
            const evenShare = targetOthers / totalOtherKeys.length;
            totalOtherKeys.forEach(s => {
                HEURISTIC_WEIGHTS[s.key] = evenShare;
                s.el.value = evenShare;
            });
        }

        // Update labels
        sliders.forEach(s => {
            s.label.textContent = HEURISTIC_WEIGHTS[s.key].toFixed(2);
        });

        sim.log(`Tuned heuristic weights dynamically: Proximity=${HEURISTIC_WEIGHTS.alpha.toFixed(2)}, Congestion=${HEURISTIC_WEIGHTS.beta.toFixed(2)}, Sequence=${HEURISTIC_WEIGHTS.gamma.toFixed(2)}, Urgency=${HEURISTIC_WEIGHTS.delta.toFixed(2)}`, 'info');
        
        // Recalculate paths immediately for active pickers to reflect new weights
        sim.pickers.forEach(picker => {
            if (picker.status === 'Picking') {
                sim.recalculatePickerPath(picker);
            }
        });
    });
});

// --- Setup Logging Event Handler ---
sim.onLogAdded = (log) => {
    const logItem = document.createElement('div');
    logItem.className = `log-item log-${log.type}`;
    logItem.innerHTML = `<span class="log-time">[${log.timestamp}]</span> ${log.message}`;
    
    consoleLogsEl.insertBefore(logItem, consoleLogsEl.firstChild);
    
    // Cap log DOM elements to 50 for performance
    if (consoleLogsEl.children.length > 50) {
        consoleLogsEl.lastChild.remove();
    }
};

// --- Click Event for manual traffic blockages & stock depletion ---
canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    
    const gridX = Math.floor(clickX / CELL_SIZE);
    const gridY = Math.floor(clickY / CELL_SIZE);
    
    if (gridX >= 0 && gridX < GRID_WIDTH && gridY >= 0 && gridY < GRID_HEIGHT) {
        if (sim.graph.isPath(gridX, gridY)) {
            // Path clicked - toggle congestion density (toggle between 0 and 5)
            const currentCongestion = sim.traffic[gridX][gridY];
            if (currentCongestion > 0) {
                sim.traffic[gridX][gridY] = 0;
                sim.log(`Cleared traffic congestion at path coordinate (${gridX}, ${gridY}).`, 'success');
            } else {
                sim.traffic[gridX][gridY] = 5;
                sim.log(`Injected BLE Aisle Congestion at path coordinate (${gridX}, ${gridY}).`, 'warning');
            }
            
            // Recalculate paths for any active pickers to adjust
            sim.pickers.forEach(picker => {
                if (picker.status === 'Picking') {
                    sim.recalculatePickerPath(picker);
                }
            });
        } else {
            // Shelf clicked - toggle stock depletion
            const sku = sim.skus.find(s => s.x === gridX && s.y === gridY);
            if (sku) {
                if (sku.stock > 0) {
                    sim.manuallyDepleteStock(sku.id);
                } else {
                    sku.stock = sku.maxStock;
                    sim.log(`Restocked shelf item ${sku.name} (${sku.id}) to maximum.`, 'success');
                }
            }
        }
    }
});

// --- Button Event Handlers ---
btnPause.addEventListener('click', () => {
    isPaused = !isPaused;
    btnPause.innerHTML = isPaused ? '▶ Resume' : '⏸ Pause';
    btnPause.classList.toggle('active', !isPaused);
    sim.log(isPaused ? 'Simulation paused.' : 'Simulation resumed.', 'info');
});

function setSpeed(speedVal, activeBtn) {
    [btn1x, btn2x, btn5x].forEach(btn => btn.classList.remove('active'));
    activeBtn.classList.add('active');
    
    if (speedVal === 1) tickIntervalMs = 1000;
    else if (speedVal === 2) tickIntervalMs = 500;
    else if (speedVal === 5) tickIntervalMs = 200;

    sim.log(`Simulation cycle tick set to ${tickIntervalMs}ms (${speedVal}x speed).`, 'info');
    
    // Restart loop timer with new interval if not paused
    if (!isPaused) {
        clearInterval(simTimer);
        startSimulationLoop();
    }
}

btn1x.addEventListener('click', () => setSpeed(1, btn1x));
btn2x.addEventListener('click', () => setSpeed(2, btn2x));
btn5x.addEventListener('click', () => setSpeed(5, btn5x));

btnSpawnOrder.addEventListener('click', () => {
    // Random item count 2 to 4, priority 1 (Normal)
    const count = 2 + Math.floor(Math.random() * 3);
    sim.spawnOrder(count, 1);
});

btnSpawnEmergency.addEventListener('click', () => {
    // Random item count 2 to 3, priority 3 (Emergency)
    const count = 2 + Math.floor(Math.random() * 2);
    sim.spawnOrder(count, 3);
});

btnRestock.addEventListener('click', () => {
    sim.manuallyRestockAll();
});

btnClearTraffic.addEventListener('click', () => {
    sim.clearCongestion();
});

selectRoutingMode.addEventListener('change', (e) => {
    const mode = e.target.value;
    sim.routingMode = mode;
    sim.log(`Switched core seek/scheduling mode to: ${mode === 'AStar' ? 'A* Heuristic (Safety First)' : 'SSTF (Seek/Proximity First)'}`, 'info');
    
    // Recalculate paths for all active pickers immediately to reflect new mode
    sim.pickers.forEach(picker => {
        if (picker.status === 'Picking') {
            sim.recalculatePickerPath(picker);
        }
    });
});

// Mutex Race Condition Injection
btnRaceCondition.addEventListener('click', () => {
    // 1. Deplete SKU-001 (Eggs) to exactly 1 item
    const targetSKU = sim.skus[0]; // Let's use the first SKU
    targetSKU.stock = 1;
    sim.log(`⚡ Injection: Initializing stock count of ${targetSKU.name} (${targetSKU.id}) to exactly 1 unit.`, 'warning');

    // 2. Spawn two separate orders requiring this exact SKU
    const order1 = {
        id: `ORD-RACE-A`,
        itemsRequested: [targetSKU.id],
        status: 'Unassigned',
        createdTime: sim.currentTime,
        slaDeadline: sim.currentTime + 90000
    };

    const order2 = {
        id: `ORD-RACE-B`,
        itemsRequested: [targetSKU.id],
        status: 'Unassigned',
        createdTime: sim.currentTime,
        slaDeadline: sim.currentTime + 90000
    };

    sim.orders.push(order1);
    sim.orders.push(order2);

    sim.log(`⚡ Spawning conflicting orders ORD-RACE-A and ORD-RACE-B targeting ${targetSKU.id}.`, 'warning');
    
    // Assign Couriers for both
    sim._spawnCourier(order1.id, order1.slaDeadline);
    sim._spawnCourier(order2.id, order2.slaDeadline);

    // Run batching and task assignments
    sim.triggerBatching();
});

// --- Dynamic View Updates ---
function updateUI() {
    // Clock
    const elapsedMs = sim.currentTime - sim.startTime;
    const hrs = Math.floor(elapsedMs / 3600000).toString().padStart(2, '0');
    const mins = Math.floor((elapsedMs % 3600000) / 60000).toString().padStart(2, '0');
    const secs = Math.floor((elapsedMs % 60000) / 1000).toString().padStart(2, '0');
    simClockEl.textContent = `${hrs}:${mins}:${secs}`;

    // KPIs
    valThroughput.textContent = sim.kpis.ordersProcessedPerHour;
    valCycleTime.textContent = (sim.kpis.averagePickCycleTimeMs / 1000).toFixed(1) + 's';
    valDistance.textContent = sim.kpis.walkingDistanceReduction + '%';
    valIntegrity.textContent = sim.kpis.crushRate + '%';
    valSLA.textContent = sim.kpis.slaCompliancePercent + '%';

    // Update colors based on levels
    valIntegrity.style.color = sim.kpis.crushRate > 10 ? 'var(--accent-pink)' : 'var(--text-primary)';
    valSLA.style.color = sim.kpis.slaCompliancePercent < 90 ? 'var(--accent-pink)' : 'var(--text-primary)';

    // Picker status list
    countPickersEl.textContent = `${sim.pickers.filter(p => p.status !== 'Idle').length} Active`;
    pickerListEl.innerHTML = '';
    sim.pickers.forEach(p => {
        const item = document.createElement('div');
        item.className = 'picker-item';
        
        let batchInfo = 'None';
        if (p.assignedBatch) {
            batchInfo = p.assignedBatch.id;
        }

        const cartBadges = p.cartContents.map(c => {
            const wClass = c.weightClass.toLowerCase();
            return `<span class="cart-item-badge badge-${wClass}">${c.symbol} ${c.id}</span>`;
        }).join('');

        let suspendedInfo = '';
        if (p.suspendedBatch) {
            suspendedInfo = `<div style="border-top: 1px dashed rgba(239, 68, 68, 0.2); padding-top: 6px; margin-top: 6px; font-size: 0.75rem; color: #f87171;">
                🚨 <strong>Suspended:</strong> ${p.suspendedBatch.id} (${p.suspendedCart.length} items collected)
            </div>`;
        }

        const batchPriorityStr = p.assignedBatch ? ` (P${p.assignedBatch.priority || 1})` : '';

        item.innerHTML = `
            <div class="picker-top">
                <span class="picker-name">
                    <span class="picker-color-dot" style="background: ${p.color};"></span>
                    ${p.name}
                </span>
                <span class="picker-status status-${p.status.toLowerCase()}">${p.status}</span>
            </div>
            <div class="picker-details">
                <div>Pos: <strong>(${p.x}, ${p.y})</strong></div>
                <div>Batch: <strong>${batchInfo}${batchPriorityStr}</strong></div>
                <div>Weight: <strong>${p.binWeight.toFixed(1)} kg</strong></div>
                <div>Dist Walked: <strong>${p.totalDistanceWalked}m</strong></div>
            </div>
            ${p.cartContents.length > 0 ? `<div class="picker-cart">${cartBadges}</div>` : ''}
            ${suspendedInfo}
        `;
        pickerListEl.appendChild(item);
    });

    // Orders queue
    const pendingOrders = sim.orders.filter(o => o.status !== 'Staged' && o.status !== 'Completed' && o.status !== 'FailedSLA');
    countOrdersEl.textContent = `${pendingOrders.length} Pending`;
    orderListEl.innerHTML = '';
    sim.orders.slice(-15).reverse().forEach(o => { // Show last 15 orders
        const item = document.createElement('div');
        item.className = 'order-item';
        
        const dots = o.itemsRequested.map(id => {
            const sku = sim.skus.find(s => s.id === id);
            let color = 'var(--text-secondary)';
            if (sku) {
                if (sku.weightClass === WEIGHT_CLASSES_VAL.HEAVY) color = 'var(--accent-orange)';
                else if (sku.weightClass === WEIGHT_CLASSES_VAL.LIGHT) color = 'var(--accent-blue)';
                else if (sku.weightClass === WEIGHT_CLASSES_VAL.FRAGILE) color = 'var(--accent-pink)';
            }
            return `<span class="order-item-dot" style="background: ${color};" title="${id}"></span>`;
        }).join(' ');

        const secondsLeft = Math.round((o.slaDeadline - sim.currentTime) / 1000);
        const urgentClass = secondsLeft < 30 && o.status !== 'Staged' ? 'sla-urgent' : '';
        const slaText = o.status === 'Staged' || o.status === 'FailedSLA' ? 'Concluded' : `${secondsLeft}s`;

        const priorityLabel = o.priority >= 3 ? ' <span style="color: #f87171; font-weight: bold;">[URGENT]</span>' : '';
        item.innerHTML = `
            <div class="order-header">
                <span>${o.id}${priorityLabel}</span>
                <span class="order-badge badge-${o.status.toLowerCase()}">${o.status}</span>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div class="order-items-grid">
                    ${dots} <span>(${o.itemsRequested.length} items)</span>
                </div>
                <div class="sla-badge ${urgentClass}">SLA: ${slaText}</div>
            </div>
        `;
        orderListEl.appendChild(item);
    });

    // Courier list
    const activeCouriers = sim.couriers.filter(c => c.status !== 'Departed');
    countCouriersEl.textContent = `${activeCouriers.length} EnRoute`;
    courierListEl.innerHTML = '';
    activeCouriers.forEach(c => {
        const item = document.createElement('div');
        item.className = 'courier-item';
        
        const etaText = c.status === 'Arrived' ? 'ARRIVED' : `${Math.round(c.etaSeconds)}s`;
        const arrivedClass = c.status === 'Arrived' ? 'courier-arrived' : '';

        item.innerHTML = `
            <div class="courier-info">
                <span class="courier-id">🚚 ${c.id}</span>
                <span class="courier-meta">Bay ${c.bayNumber} | Order ${c.assignedOrderIds.join(', ')}</span>
            </div>
            <div class="courier-eta ${arrivedClass}">${etaText}</div>
        `;
        courierListEl.appendChild(item);
    });

    // Update System Execution Pipeline
    const steps = ['receive', 'priority', 'preemption', 'sstf', 'move'];
    steps.forEach(step => {
        const stepEl = document.getElementById(`step-${step}`);
        const statusEl = document.getElementById(`status-${step}`);
        const state = sim.pipelineState[step];
        if (stepEl && statusEl && state) {
            statusEl.textContent = state.text;
            if (state.active) {
                stepEl.classList.add('active');
            } else {
                stepEl.classList.remove('active');
            }
        }
    });
}

// --- Canvas Drawing Logic ---
function drawWarehouse() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw Grid Cells
    for (let x = 0; x < GRID_WIDTH; x++) {
        for (let y = 0; y < GRID_HEIGHT; y++) {
            const cellType = sim.graph.grid[x][y];
            const px = x * CELL_SIZE;
            const py = y * CELL_SIZE;

            // 1. Draw Cell Background
            if (cellType === 'walkway') {
                ctx.fillStyle = '#111116';
                ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
                ctx.strokeRect(px, py, CELL_SIZE, CELL_SIZE);
            } else if (cellType === 'aisle') {
                ctx.fillStyle = '#14141d';
                ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
                ctx.strokeRect(px, py, CELL_SIZE, CELL_SIZE);
            } else if (cellType === 'staging') {
                ctx.fillStyle = '#1e1b4b';
                ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
                ctx.strokeStyle = 'rgba(139, 92, 246, 0.3)';
                ctx.strokeRect(px, py, CELL_SIZE, CELL_SIZE);
                ctx.fillStyle = '#8b5cf6';
                ctx.font = 'bold 8px Inter';
                ctx.fillText('STAGING', px + 6, py + 28);
            } else if (cellType === 'packing') {
                ctx.fillStyle = '#311042';
                ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
                ctx.strokeStyle = '#a78bfa';
                ctx.strokeRect(px, py, CELL_SIZE, CELL_SIZE);
                ctx.fillStyle = '#a78bfa';
                ctx.font = 'bold 8px Inter';
                ctx.fillText('PACKING', px + 6, py + 28);
            } else {
                // Shelf cells
                ctx.fillStyle = '#07070d';
                ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.01)';
                ctx.strokeRect(px, py, CELL_SIZE, CELL_SIZE);
            }

            // 2. Draw active congestion heatmap
            const trafficDensity = sim.traffic[x][y];
            if (trafficDensity > 0) {
                ctx.fillStyle = `rgba(239, 68, 68, ${Math.min(0.6, trafficDensity * 0.12)})`;
                ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
                ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
                ctx.strokeRect(px, py, CELL_SIZE, CELL_SIZE);
            }
        }
    }

    // Draw Chilled Zones (Visual backdrop overlay)
    // Let's designate columns 12 and 13 as temperature controlled chilled zones
    ctx.fillStyle = 'rgba(6, 182, 212, 0.04)';
    ctx.fillRect(12 * CELL_SIZE, 0, 2 * CELL_SIZE, 11 * CELL_SIZE);
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.15)';
    ctx.strokeRect(12 * CELL_SIZE, 0, 2 * CELL_SIZE, 11 * CELL_SIZE);
    
    ctx.fillStyle = 'rgba(6, 182, 212, 0.4)';
    ctx.font = '500 8px Outfit';
    ctx.fillText('❄️ CHILLED ZONE', 12 * CELL_SIZE + 8, 15);

    // Draw SKUs on shelves
    sim.skus.forEach(sku => {
        const px = sku.x * CELL_SIZE;
        const py = sku.y * CELL_SIZE;

        // Draw SKU borders based on weight class
        ctx.lineWidth = 1;
        if (sku.weightClass === WEIGHT_CLASSES_VAL.HEAVY) {
            ctx.strokeStyle = 'rgba(245, 158, 11, 0.35)';
        } else if (sku.weightClass === WEIGHT_CLASSES_VAL.LIGHT) {
            ctx.strokeStyle = 'rgba(6, 182, 212, 0.35)';
        } else {
            ctx.strokeStyle = 'rgba(236, 72, 153, 0.35)';
        }
        ctx.strokeRect(px + 3, py + 3, CELL_SIZE - 6, CELL_SIZE - 6);

        // Draw SKU Symbol
        ctx.font = '16px Inter';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        if (sku.stock === 0) {
            // Draw depleted faded symbol
            ctx.save();
            ctx.globalAlpha = 0.15;
            ctx.fillText(sku.symbol, px + CELL_SIZE/2, py + CELL_SIZE/2 - 4);
            ctx.restore();

            // Stock Count OUT
            ctx.fillStyle = '#ef4444';
            ctx.font = 'bold 8px Inter';
            ctx.fillText('OUT', px + CELL_SIZE/2, py + CELL_SIZE/2 + 12);
        } else {
            ctx.fillText(sku.symbol, px + CELL_SIZE/2, py + CELL_SIZE/2 - 4);

            // Stock Count
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.font = 'monospace 8px';
            ctx.fillText(sku.stock.toString(), px + CELL_SIZE/2, py + CELL_SIZE/2 + 12);
        }
    });

    // Draw Picker Paths
    sim.pickers.forEach(picker => {
        if (picker.status === 'Picking' && picker.path && picker.path.length > 0) {
            ctx.save();
            ctx.strokeStyle = picker.color;
            ctx.lineWidth = 3;
            ctx.lineJoin = 'round';
            ctx.globalAlpha = 0.5;
            
            // Add slight drop shadow glow to line
            ctx.shadowColor = picker.color;
            ctx.shadowBlur = 6;

            ctx.beginPath();
            // Start from picker's visual position (or first node)
            const visual = pickerVisuals[picker.id];
            ctx.moveTo(visual.x, visual.y);

            // Draw line through rest of remaining path
            for (let i = picker.pathIndex; i < picker.path.length; i++) {
                const step = picker.path[i];
                const sx = step.x * CELL_SIZE + CELL_SIZE/2;
                const sy = step.y * CELL_SIZE + CELL_SIZE/2;
                ctx.lineTo(sx, sy);
            }
            ctx.stroke();
            ctx.restore();

            // Draw target items marked on the path
            for (let i = picker.pathIndex; i < picker.path.length; i++) {
                const step = picker.path[i];
                if (step.action.startsWith('pick:')) {
                    // Find the SKU to draw indicator
                    const sku = sim.skus.find(s => s.id === step.skuId);
                    if (sku) {
                        ctx.save();
                        ctx.strokeStyle = picker.color;
                        ctx.lineWidth = 2;
                        ctx.shadowColor = picker.color;
                        ctx.shadowBlur = 8;
                        ctx.beginPath();
                        ctx.arc(sku.x * CELL_SIZE + CELL_SIZE/2, sku.y * CELL_SIZE + CELL_SIZE/2, 16, 0, 2*Math.PI);
                        ctx.stroke();
                        ctx.restore();
                    }
                }
            }
        }
    });

    // Draw Picker Avatars
    sim.pickers.forEach(picker => {
        const visual = pickerVisuals[picker.id];
        const targetX = picker.x * CELL_SIZE + CELL_SIZE/2;
        const targetY = picker.y * CELL_SIZE + CELL_SIZE/2;

        // Visual LERP (interpolating for smooth animation)
        visual.x += (targetX - visual.x) * 0.15;
        visual.y += (targetY - visual.y) * 0.15;

        ctx.save();
        ctx.fillStyle = picker.color;
        ctx.shadowColor = picker.color;
        ctx.shadowBlur = 10;
        
        ctx.beginPath();
        ctx.arc(visual.x, visual.y, 14, 0, 2 * Math.PI);
        ctx.fill();

        // Draw white border if lock contention blocked
        if (picker.blockedTicks > 0) {
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 3;
            ctx.stroke();
        } else {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
        ctx.restore();

        // Label
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px Inter';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Display first letter of picker name
        ctx.fillText(picker.name.split(' ')[1][0], visual.x, visual.y);
    });
}

// --- Main Simulation Loops ---
function tickSimulation() {
    if (!isPaused) {
        sim.tick(1000); // Step 1 simulation second
        updateUI();
    }
}

function startSimulationLoop() {
    simTimer = setInterval(tickSimulation, tickIntervalMs);
}

// Web Animation Frame render loop (smooth graphics rendering)
function animationLoop() {
    drawWarehouse();
    requestAnimationFrame(animationLoop);
}




// --- Initial Spawning and Start ---
// Spawn some initial orders to get things moving
for (let i = 0; i < 4; i++) {
    sim.spawnOrder(2 + Math.floor(Math.random() * 2));
}

// Start simulation tick timer and canvas render loop
startSimulationLoop();
requestAnimationFrame(animationLoop);

// Log initial message
sim.log("FulfillmentOS initialized. A* Pathfinder configured with default PEAS metrics.", "success");
sim.log("Use Event Injection panel to trigger Mutex conflicts or draw traffic lanes.", "info");

// Adjust starting heuristic sliders labels
sliders.forEach(s => {
    s.el.value = HEURISTIC_WEIGHTS[s.key];
    s.label.textContent = HEURISTIC_WEIGHTS[s.key].toFixed(2);
});
