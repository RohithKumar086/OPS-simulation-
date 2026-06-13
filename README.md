# FulfillmentOS - Micro-Fulfillment Agent Simulation

FulfillmentOS is a high-fidelity visual simulation of a dark-store warehouse micro-fulfillment system. The project demonstrates real-time pathfinding, batching, and inventory transaction control using the PEAS framework, state-space representations, and a custom multi-factor heuristic engine for $A^*$ search.

## Features

### 1. Informed $A^*$ Search Engine
- **State-Space bitmask**: Encodes picker position and picked SKU tracking in a composite state tuple: `(x, y, picked_mask)`. This allows A* to solve the TSP routing problem and shortest path generation in a single unified graph traversal.
- **Dynamic Heuristics**: Calculates $f(n) = g(n) + h(n)$ at each candidate node $n$.
  - $g(n)$: Travel cost modulated by active aisle traffic (BLE beacons tracking localized worker congestion).
  - $h(n) = \alpha \cdot h_{\text{prox}}(n) + \beta \cdot h_{\text{cong}}(n) + \gamma \cdot h_{\text{seq}}(n) + \delta \cdot h_{\text{urg}}(n)$
    - **Proximity Vector** ($\alpha = 0.40$): Remaining distance to the target packing station.
    - **Aisle Congestion Matrix** ($\beta = 0.25$): Penalty to guide pickers away from narrow lanes with high congestion.
    - **Structural Sequence Safety Index** ($\gamma = 0.20$): Applies severe mathematical penalties when trying to pick Heavy items *after* Fragile items have already entered the picking cart, preventing inventory damage.
    - **Courier Urgency Factor** ($\delta = 0.15$): Dynamically priorities orders with imminent courier ETA deadlines.
- **Priority Queue**: Managed as a binary min-heap for $O(\log n)$ node expansion.

### 2. Concurrency Control & Mutex Locks
- Exposes shelf-record layer mutual exclusion (mutex) locks.
- Two pickers competing for the same final SKU slot are serialized; the losing picker experiences a **Cache Exception** (zero inventory count), releases their lock block, and triggers an immediate $A^*$ re-search to find alternative shelf nodes or route directly to the packing bay.

### 3. Interactive Web Dashboard
- Obsidian dark-mode with glassmorphism visual styling.
- Real-time KPI trackers (Throughput, Pick Cycle Time, Walking Distance Reduction, Product Damage Rate, SLA Compliance).
- Live 2D canvas drawing layout of aisles, walkways, chilled zones, and shelves (color-coded by Weight Class).
- Glowing path overlays showing active picker routes and targeted SKUs.
- Interactive controls: spawn orders, adjust heuristic weights in real-time, restock shelves, clear congestion, or manually block aisles by clicking on path grid cells.
- **Trigger Mutex Race button**: Artificially sets a SKU stock to 1, and spawns two conflicting orders simultaneously to visually demonstrate mutex locks and re-pathing exceptions.

## Tech Stack
- **Structure**: HTML5 Semantic Layout
- **Style**: Vanilla CSS3 Custom Variables + Animations
- **Logic**: Vanilla ES6 JavaScript (No compilation/transpilation or heavy packages required)

## Getting Started

To run the simulation locally:

1. **Serve the project** using any light web server. For example:
   ```bash
   # If you have Python installed:
   python -m http.server 8000
   
   # Or using Node:
   npx serve .
   ```
2. Open `http://localhost:8000` (or the port specified by your server) in your browser.

## Project Structure
- `index.html`: Entry point & UI containers.
- `style.css`: Obsidian/Glassmorphic stylesheet.
- `agent.js`: Min-Heap Priority Queue, Warehouse Graph structure, A* Pathfinder, and Heuristic functions.
- `simulation.js`: Core simulation tick loop, state mutators, telemetry updates, and mutex lock logic.
- `app.js`: Canvas drawing context, LERP transitions, and DOM event bindings.
