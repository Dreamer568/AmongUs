# Implementation Plan - Task Closure & Server-Side Task Management

This plan addresses two core requirements:
1. **Task Iframe Closure Bug**: Registering a window-level postMessage listener on the client so that completion messages from task iframes trigger task completion and close the modal.
2. **Server-Side Task/Progress Management**: 
   * Moving task set assignment to the server upon player join.
   * Calculating and managing the global progress bar dynamically on the server and broadcasting it to all clients on player joins, leaves, and task completions.

---

## Proposed Changes

### [Multiplayer Server]

#### [MODIFY] [multiplayer.js](file:///c:/Users/conta/Desktop/AmongUs/multiplayer.js)
* Load `task_sets.json` using the `fs` module when starting.
* Update `join` socket handler to:
  * Select a random task set from the loaded task sets.
  * Store it in `socket.playerProfile.assignedTaskSet`.
  * Return this set inside the `initial_state` event payload.
* Add helper `getGlobalProgress()` to calculate the aggregate completion percentage across all active sockets:
  $$\text{Progress} = \frac{\sum \text{completed tasks}}{\sum \text{total assigned tasks}} \times 100$$
* Emit the updated progress value (`progress_update`) to all clients:
  * Immediately after a player joins.
  * When a player disconnects.
  * When a player broadcasts a `task_complete` event.

---

### [Client UI & Loop]

#### [MODIFY] [game.html](file:///c:/Users/conta/Desktop/AmongUs/game.html)
* **Register postMessage Listener**: Inside `init()`, add a listener for `message` events:
  ```javascript
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'TASK_COMPLETE') {
      resolveTaskCompleted();
    }
  });
  ```
* **Asynchronous Task Initialization**:
  * Decouple checklist rendering and 3D task sphere loading from client startup.
  * Implement `initializeTasksAndConfig(taskSet)` to render the UI, load configs, and spawn spheres.
  * In online mode, wait for `initial_state` message from Socket.io, then invoke `initializeTasksAndConfig` with the server-assigned task set.
  * In offline mode (if Socket.io fails to load/connect), fall back to loading the task set locally as before.
* **Server-Driven Progress Bar**:
  * Listen for `progress_update` socket events to update the HUD progress bar.
  * Modify `updateTotalProgress()` to only perform local updates if running in offline mode.

---

## Verification Plan

### Automated/Manual Verification
* **Local Minigame Test**: Run the server, join, approach a task (e.g. Swipe Card), complete it, and verify that:
  * The iframe modal closes automatically.
  * The task is checked off in the checklist.
  * The global progress bar updates.
* **Multiplayer Simulation**: Connect two browser tabs:
  * Verify that both tabs show the global progress bar adjusting when a task is completed.
  * Verify that joining/leaving dynamically adjusts the progress bar percentage.
