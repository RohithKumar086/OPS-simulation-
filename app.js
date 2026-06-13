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
    drawGanttChart();
    requestAnimationFrame(animationLoop);
}

// --- GANTT CHART RENDERING (Preemptive Priority Scheduling) ---
const ganttCanvas = document.getElementById('gantt-canvas');
const ganttCtx = ganttCanvas.getContext('2d');
const ganttViewport = document.querySelector('.gantt-viewport');
const ganttTickCounter = document.getElementById('gantt-tick-counter');
const ganttPreemptionCount = document.getElementById('gantt-preemption-count');
const ganttContextSwitches = document.getElementById('gantt-context-switches');
const ganttAvgWait = document.getElementById('gantt-avg-wait');
const ganttAvgTurnaround = document.getElementById('gantt-avg-turnaround');
const ganttProcessTbody = document.getElementById('gantt-process-tbody');

// Gantt chart layout constants
const GANTT = {
    rowHeight: 48,
    labelWidth: 115,
    tickWidth: 12,
    topPadding: 32,
    barHeight: 28,
    barRadius: 5,
    idleBarHeight: 4,
    visibleTicks: 80
};

// Priority-based color palette (the core of preemptive priority scheduling visualization)
const PRIORITY_COLORS = {
    1: { // P1 - Normal
        fill: 'rgba(59, 130, 246, 0.75)',
        stroke: 'rgba(37, 99, 235, 0.9)',
        glow: 'rgba(59, 130, 246, 0.2)',
        text: '#dbeafe',
        label: 'P1'
    },
    2: { // P2 - Medium (if used)
        fill: 'rgba(234, 179, 8, 0.7)',
        stroke: 'rgba(202, 138, 4, 0.9)',
        glow: 'rgba(234, 179, 8, 0.2)',
        text: '#fef9c3',
        label: 'P2'
    },
    3: { // P3 - Emergency / Highest priority
        fill: 'rgba(244, 63, 94, 0.85)',
        stroke: 'rgba(225, 29, 72, 1)',
        glow: 'rgba(244, 63, 94, 0.3)',
        text: '#ffe4e6',
        label: 'P3'
    }
};

const SPECIAL_COLORS = {
    idle: { fill: 'rgba(75, 85, 99, 0.2)', stroke: 'rgba(107, 114, 128, 0.15)' },
    preempted: { fill: 'rgba(245, 158, 11, 0.6)', stroke: 'rgba(217, 119, 6, 0.8)' },
    blocked: { fill: 'rgba(239, 68, 68, 0.55)', stroke: 'rgba(220, 38, 38, 0.7)' },
    packing: { stripe: 'rgba(255, 255, 255, 0.12)' }
};

function drawGanttChart() {
    const segments = sim.getGanttData();
    const pickers = sim.pickers;
    const currentTick = sim.ganttTick;
    const numRows = pickers.length;

    // Visible range (auto-scroll to show latest)
    const startTick = Math.max(0, currentTick - GANTT.visibleTicks);
    const endTick = currentTick + 5;
    const totalVisibleTicks = endTick - startTick;
    const canvasWidth = GANTT.labelWidth + totalVisibleTicks * GANTT.tickWidth + 20;
    const canvasHeight = GANTT.topPadding + numRows * GANTT.rowHeight + 28;

    if (ganttCanvas.width !== canvasWidth || ganttCanvas.height !== canvasHeight) {
        ganttCanvas.width = canvasWidth;
        ganttCanvas.height = canvasHeight;
    }

    const ctx = ganttCtx;
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    const L = GANTT.labelWidth;
    const T = GANTT.topPadding;

    // ── Time axis gridlines ──
    for (let tick = startTick; tick <= endTick; tick++) {
        const x = L + (tick - startTick) * GANTT.tickWidth;
        if (tick % 10 === 0) {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, T - 6);
            ctx.lineTo(x, T + numRows * GANTT.rowHeight);
            ctx.stroke();
            ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
            ctx.font = '500 9px Inter';
            ctx.textAlign = 'center';
            ctx.fillText(`t=${tick}`, x, T - 10);
        } else if (tick % 5 === 0) {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, T);
            ctx.lineTo(x, T + numRows * GANTT.rowHeight);
            ctx.stroke();
        }
    }

    // ── Row separators ──
    for (let i = 0; i <= numRows; i++) {
        const y = T + i * GANTT.rowHeight;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvasWidth, y);
        ctx.stroke();
    }

    // ── Picker row labels ──
    pickers.forEach((picker, idx) => {
        const y = T + idx * GANTT.rowHeight + GANTT.rowHeight / 2;
        // Color dot
        ctx.save();
        ctx.fillStyle = picker.color;
        ctx.shadowColor = picker.color;
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.arc(14, y, 5, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
        // Name
        ctx.fillStyle = '#e2e8f0';
        ctx.font = '600 11px Inter';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(picker.name, 26, y - 4);
        // Status
        ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.font = '500 8px Inter';
        ctx.fillText(`(${picker.status})`, 26, y + 10);
    });

    // ── Label/chart separator ──
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L, T - 6);
    ctx.lineTo(L, T + numRows * GANTT.rowHeight);
    ctx.stroke();

    // ── Build picker index map ──
    const pickerIdxMap = {};
    pickers.forEach((p, i) => { pickerIdxMap[p.id] = i; });

    let preemptionCount = 0;

    // ── Draw scheduling segments ──
    for (const seg of segments) {
        const rowIdx = pickerIdxMap[seg.pickerId];
        if (rowIdx === undefined) continue;
        if (seg.endTick < startTick || seg.startTick > endTick) continue;

        const clippedStart = Math.max(seg.startTick, startTick);
        const clippedEnd = Math.min(seg.endTick, endTick);
        const x = L + (clippedStart - startTick) * GANTT.tickWidth;
        const w = Math.max(3, (clippedEnd - clippedStart + 1) * GANTT.tickWidth);
        const rowY = T + rowIdx * GANTT.rowHeight;

        // ─── IDLE: thin center line ───
        if (seg.type === 'idle') {
            const iy = rowY + GANTT.rowHeight / 2 - GANTT.idleBarHeight / 2;
            ctx.fillStyle = SPECIAL_COLORS.idle.fill;
            ctx.strokeStyle = SPECIAL_COLORS.idle.stroke;
            ctx.lineWidth = 0.5;
            _roundRect(ctx, x, iy, w, GANTT.idleBarHeight, 2);
            ctx.fill();
            ctx.stroke();
            continue;
        }

        const y = rowY + (GANTT.rowHeight - GANTT.barHeight) / 2;
        const h = GANTT.barHeight;
        const priority = seg.priority || 1;
        const pColors = PRIORITY_COLORS[priority] || PRIORITY_COLORS[1];

        ctx.save();

        // ─── PREEMPTED: hatched orange bar ───
        if (seg.type === 'preempted') {
            preemptionCount++;
            ctx.fillStyle = SPECIAL_COLORS.preempted.fill;
            ctx.strokeStyle = SPECIAL_COLORS.preempted.stroke;
            ctx.lineWidth = 1.5;
            _roundRect(ctx, x, y, w, h, GANTT.barRadius);
            ctx.fill();
            ctx.stroke();
            // Diagonal hatch
            ctx.save();
            ctx.beginPath();
            _roundRect(ctx, x, y, w, h, GANTT.barRadius);
            ctx.clip();
            ctx.strokeStyle = 'rgba(217, 119, 6, 0.5)';
            ctx.lineWidth = 1.5;
            for (let i = -h; i < w + h; i += 6) {
                ctx.beginPath();
                ctx.moveTo(x + i, y);
                ctx.lineTo(x + i + h, y + h);
                ctx.stroke();
            }
            ctx.restore();
            // Label inside
            if (w > 24) {
                ctx.fillStyle = '#fef3c7';
                ctx.font = 'bold 8px Inter';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(`P${priority} PREEMPTED`, x + w / 2, y + h / 2);
            }
            // ⚡ marker at end
            ctx.fillStyle = '#f59e0b';
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(245, 158, 11, 0.7)';
            ctx.shadowBlur = 8;
            ctx.fillText('⚡', x + w + 2, y + h / 2);
            ctx.restore();
            continue;
        }

        // ─── BLOCKED: red cross-hatch ───
        if (seg.type === 'blocked') {
            ctx.fillStyle = SPECIAL_COLORS.blocked.fill;
            ctx.strokeStyle = SPECIAL_COLORS.blocked.stroke;
            ctx.lineWidth = 1.5;
            _roundRect(ctx, x, y, w, h, GANTT.barRadius);
            ctx.fill();
            ctx.stroke();
            ctx.save();
            ctx.beginPath();
            _roundRect(ctx, x, y, w, h, GANTT.barRadius);
            ctx.clip();
            ctx.strokeStyle = 'rgba(220, 38, 38, 0.4)';
            ctx.lineWidth = 1.5;
            for (let i = -h; i < w + h; i += 6) {
                ctx.beginPath();
                ctx.moveTo(x + i, y + h);
                ctx.lineTo(x + i + h, y);
                ctx.stroke();
            }
            ctx.restore();
            if (w > 20) {
                ctx.fillStyle = '#fecaca';
                ctx.font = 'bold 7px Inter';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('BLOCKED', x + w / 2, y + h / 2);
            }
            ctx.restore();
            continue;
        }

        // ─── PICKING or PACKING: color by PRIORITY LEVEL ───
        // Glow for active (current) segments
        if (seg.endTick >= currentTick - 1) {
            ctx.shadowColor = pColors.glow;
            ctx.shadowBlur = 10;
        }
        ctx.fillStyle = pColors.fill;
        ctx.strokeStyle = pColors.stroke;
        ctx.lineWidth = 1.5;
        _roundRect(ctx, x, y, w, h, GANTT.barRadius);
        ctx.fill();
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Packing overlay: diagonal stripe pattern (same priority color, striped)
        if (seg.type === 'packing') {
            ctx.save();
            ctx.beginPath();
            _roundRect(ctx, x, y, w, h, GANTT.barRadius);
            ctx.clip();
            ctx.strokeStyle = SPECIAL_COLORS.packing.stripe;
            ctx.lineWidth = 2;
            for (let i = -h; i < w + h; i += 7) {
                ctx.beginPath();
                ctx.moveTo(x + i, y);
                ctx.lineTo(x + i + h, y + h);
                ctx.stroke();
            }
            ctx.restore();
        }

        // ─── Priority label + batch ID inside bar ───
        if (w > 14) {
            ctx.fillStyle = pColors.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            if (w > 55 && seg.batchId) {
                // Full label: "P1: batch-xxx" or "P3: batch-xxx ⚡"
                ctx.font = 'bold 9px Inter';
                const suffix = seg.type === 'packing' ? ' [PACK]' : '';
                const prefix = priority >= 3 ? '🚨 ' : '';
                const label = `${prefix}${pColors.label}: ${seg.batchId}${suffix}`;
                const maxChars = Math.floor(w / 6.5);
                ctx.fillText(label.length > maxChars ? label.substring(0, maxChars) + '…' : label, x + w / 2, y + h / 2);
            } else if (w > 28) {
                // Short label: "P1" or "P3"
                ctx.font = 'bold 10px Inter';
                ctx.fillText(pColors.label, x + w / 2, y + h / 2);
            } else {
                // Tiny: just priority number
                ctx.font = 'bold 8px Inter';
                ctx.fillText(priority.toString(), x + w / 2, y + h / 2);
            }
        }

        ctx.restore();
    }

    // ── Arrival markers (▼ triangles on timeline) ──
    if (sim.ganttArrivals) {
        for (const arrival of sim.ganttArrivals) {
            if (arrival.tick < startTick || arrival.tick > endTick) continue;
            const ax = L + (arrival.tick - startTick) * GANTT.tickWidth;
            const pCol = PRIORITY_COLORS[arrival.priority] || PRIORITY_COLORS[1];
            // Draw downward triangle above the chart
            ctx.save();
            ctx.fillStyle = arrival.priority >= 3 ? '#f43f5e' : '#22c55e';
            ctx.shadowColor = ctx.fillStyle;
            ctx.shadowBlur = 4;
            ctx.beginPath();
            ctx.moveTo(ax - 4, T - 5);
            ctx.lineTo(ax + 4, T - 5);
            ctx.lineTo(ax, T + 1);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
            // Small dashed vertical line
            ctx.save();
            ctx.strokeStyle = arrival.priority >= 3 ? 'rgba(244, 63, 94, 0.3)' : 'rgba(34, 197, 94, 0.2)';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(ax, T);
            ctx.lineTo(ax, T + numRows * GANTT.rowHeight);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
        }
    }

    // ── Resume markers (🔄 on timeline) ──
    if (sim.ganttResumes) {
        for (const resume of sim.ganttResumes) {
            if (resume.tick < startTick || resume.tick > endTick) continue;
            const rx = L + (resume.tick - startTick) * GANTT.tickWidth;
            const rowIdx = pickerIdxMap[resume.pickerId];
            if (rowIdx === undefined) continue;
            const ry = T + rowIdx * GANTT.rowHeight + GANTT.rowHeight / 2;
            ctx.save();
            ctx.fillStyle = '#10b981';
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(16, 185, 129, 0.6)';
            ctx.shadowBlur = 6;
            ctx.fillText('🔄', rx - 2, ry - GANTT.barHeight / 2 - 6);
            ctx.restore();
        }
    }

    // ── Current time indicator (NOW line) ──
    const nowX = L + (currentTick - startTick) * GANTT.tickWidth;
    if (nowX >= L && nowX <= canvasWidth) {
        ctx.save();
        ctx.strokeStyle = 'rgba(244, 63, 94, 0.65)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(nowX, T - 6);
        ctx.lineTo(nowX, T + numRows * GANTT.rowHeight);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(244, 63, 94, 0.9)';
        ctx.font = 'bold 8px Inter';
        ctx.textAlign = 'center';
        ctx.fillText('NOW', nowX, T - 16);
        ctx.restore();
    }

    // ── Time axis label ──
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.font = '500 8px Inter';
    ctx.textAlign = 'right';
    ctx.fillText('Time (ticks) →', canvasWidth - 8, T + numRows * GANTT.rowHeight + 14);

    // Auto-scroll viewport
    if (ganttViewport) {
        ganttViewport.scrollLeft = Math.max(0, canvasWidth - ganttViewport.clientWidth + 20);
    }

    // ── Count context switches ──
    const contextSwitchCount = sim.ganttResumes ? sim.ganttResumes.length : 0;

    // ── Compute scheduling metrics from process table ──
    let totalWait = 0, totalTAT = 0, completedCount = 0;
    if (sim.ganttProcessTable) {
        for (const [batchId, entry] of sim.ganttProcessTable) {
            if (entry.completionTick !== null && entry.startTick !== null) {
                const turnaround = entry.completionTick - entry.arrivalTick;
                const execution = entry.executionTicks || 0;
                const waitTime = Math.max(0, turnaround - execution);
                totalWait += waitTime;
                totalTAT += turnaround;
                completedCount++;
            }
        }
    }
    const avgWait = completedCount > 0 ? (totalWait / completedCount).toFixed(1) : '0';
    const avgTAT = completedCount > 0 ? (totalTAT / completedCount).toFixed(1) : '0';

    // ── Update info bar ──
    if (ganttTickCounter) ganttTickCounter.textContent = `⏱ Tick: ${currentTick}`;
    if (ganttPreemptionCount) ganttPreemptionCount.textContent = `⚡ Preemptions: ${preemptionCount}`;
    if (ganttContextSwitches) ganttContextSwitches.textContent = `🔄 Ctx Switches: ${contextSwitchCount}`;
    if (ganttAvgWait) ganttAvgWait.textContent = `⏳ Avg Wait: ${avgWait}s`;
    if (ganttAvgTurnaround) ganttAvgTurnaround.textContent = `📊 Avg TAT: ${avgTAT}s`;

    // ── Update process scheduling table ──
    _updateProcessTable();
}

function _updateProcessTable() {
    if (!ganttProcessTbody || !sim.ganttProcessTable) return;
    ganttProcessTbody.innerHTML = '';

    // Sort: show most recent first, emergency first within same arrival
    const entries = Array.from(sim.ganttProcessTable.entries())
        .sort((a, b) => {
            if (b[1].priority !== a[1].priority) return b[1].priority - a[1].priority;
            return b[1].arrivalTick - a[1].arrivalTick;
        })
        .slice(0, 12); // Show last 12

    for (const [batchId, e] of entries) {
        const turnaround = (e.completionTick !== null) ? (e.completionTick - e.arrivalTick) : '—';
        const execution = e.executionTicks || 0;
        
        let waitTime;
        if (e.completionTick !== null) {
            waitTime = Math.max(0, (e.completionTick - e.arrivalTick) - execution);
        } else if (e.startTick !== null) {
            waitTime = Math.max(0, (sim.ganttTick - e.arrivalTick) - execution);
        } else {
            waitTime = Math.max(0, sim.ganttTick - e.arrivalTick);
        }

        const priorityClass = e.priority >= 3 ? 'pt-priority-p3' : 'pt-priority-p1';
        let statusClass = 'pt-status-waiting';
        let statusText = e.status;
        if (e.status === 'Running') statusClass = 'pt-status-running';
        else if (e.status === 'Packing') statusClass = 'pt-status-packing';
        else if (e.status === 'Suspended') statusClass = 'pt-status-suspended';
        else if (e.status === 'Completed') statusClass = 'pt-status-completed';

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${batchId}</td>
            <td class="${priorityClass}">${e.priority >= 3 ? '🚨 P' + e.priority : 'P' + e.priority}</td>
            <td>${e.arrivalTick}s</td>
            <td>${e.startTick !== null ? e.startTick + 's' : '—'}</td>
            <td>${e.completionTick !== null ? e.completionTick + 's' : '—'}</td>
            <td>${typeof waitTime === 'number' ? waitTime + 's' : waitTime}</td>
            <td>${typeof turnaround === 'number' ? turnaround + 's' : turnaround}</td>
            <td><span class="pt-status ${statusClass}">${statusText}</span></td>
        `;
        ganttProcessTbody.appendChild(row);
    }
}

// Helper: draw rounded rectangle path
function _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
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
