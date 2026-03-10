Implementing hot swapping in JavaScript runtimes (Node, Deno, Bun, Browser) actually aligns perfectly with the **"rolling hot swap by replacement"** model outlined in OTP.md. 

Because you aren't trying to mutate the *internal state* of an existing JavaScript function (which JS doesn't allow), you only need to dynamically load a *new* function into memory, spawn a new task, update the t2-agc registry, and let the old task die.

Here are the mechanisms you can leverage to implement this across different runtimes:

### 1. The Universal Modern Standard: Dynamic `import()` + Cache Busting
All modern JS runtimes (Node, Deno, Bun, and Browsers) support ES modules and dynamic imports via `await import(string)`. 

The catch is that JS runtimes heavily cache modules based on their URL. If you try to `import("./my-behavior.js")` a second time, it just gives you the old cached version. To bypass this, you use a **cache-busting query string**:

```javascript
// Step 1: Load the new behavior dynamically
const version = Date.now(); // or a git hash, t2-version tag, etc.
const newModule = await import(`./chat-room.js?v=${version}`);

// Step 2: Extract the compiled t2 task definition
const newBehavior = newModule.default;

// Step 3: Tell t2-agc to spawn the new tasks
const newPid = t2agc.spawn(newBehavior, [cap1, cap2]);

// Step 4: Update the registry
t2agc.send(REGISTRY_PID, { tag: ":register", name: "chat-room", pid: newPid });

// Step 5: Tell the old PID to shut down gracefully
t2agc.send(oldPid, { tag: ":drain_and_exit" });
```
* **Node/Bun/Deno/Browser**: All perfectly support `import("./file.js?v=...")` right out of the box.
* **Network loading**: Deno and Browsers can even hot-load behaviors directly over the network: `await import("https://cdn.my-t2-app.com/chat-room@v2.js")`.

### 2. t2-lang specific: `new Function` / Execution from String
Since t2-lang generates JS natively (via a macro/compiler pipeline) or compiles to IR, your runtime might not actually read JS files from disk. Instead, you might receive the compiled task code via a WebSocket, an API call, or an IPC message.

In this case, all JavaScript runtimes can evaluate raw strings of code on the fly:

```javascript
// Receive new compiled t2 code over network 
const incomingJSString = "... compiled t2 output ...";

// Dynamically create a new function
// (This creates a strict boundary, preventing it from messing with local lexical scope)
const newTaskDefinition = new Function("capabilities", incomingJSString);

// Spawn and register it as above
```

### Summary of how it fits t2-agc:
The beauty of the Erlang-style model you've chosen is that **the runtime itself doesn't need magical VM-level swapping capabilities**. 

Because actors communicate *only* via `send` to a Registry or Router, the JavaScript runtime merely needs to hold two functions in memory at the same time (`chatRoomV1` and `chatRoomV2`). The router handles the transition, allowing V1 to finish its current loop and cleanly terminate, naturally garbage collecting the old code when JS garbage collects the old V1 module.
