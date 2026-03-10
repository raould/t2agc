# Examples

- For each of these, also show how to enable verbose debug logging, to demonstrate the full system behavior.

## 🌟 1. The “Ping‑Pong” Example  
This is *the* canonical Erlang tutorial example.

### Why it’s perfect for t2‑agc
- Two tasks  
- Each sends messages to the other  
- Demonstrates `spawn`, `send`, `receive`, `yield`  
- Shows mailbox behavior  
- Shows cooperative scheduling  
- Shows how tasks terminate  

### Erlang version (conceptual)
Two processes bounce a message back and forth until a counter hits zero.

### t2‑agc version (conceptual)
```t2
(task ping (:priority :normal)
  (loop
    (let (msg (receive))
      (match msg
        ('(:pong n)
          (if (> n 0)
              (begin
                (send pong '(:ping (- n 1)))
                (yield)
                (recur))
              (send pong '(:done))))))))

(task pong (:priority :normal)
  (loop
    (let (msg (receive))
      (match msg
        ('(:ping n)
          (if (> n 0)
              (begin
                (send ping '(:pong (- n 1)))
                (yield)
                (recur))
              (send ping '(:done))))))))
```

This is a *perfect* “Hello World” for t2‑agc.

---

## 🌟 2. The “Echo Server”  
Another classic Erlang tutorial example.

### Why it’s perfect
- One long‑lived actor  
- Many short‑lived clients  
- Demonstrates mailbox semantics  
- Demonstrates actor loops  
- Demonstrates simple pattern matching  

### t2‑agc version (conceptual)
```t2
(task echo-server ()
  (loop
    (let (msg (receive))
      (match msg
        ('(:echo from payload)
          (send from payload)
          (yield)
          (recur))))))
```

Clients:

```t2
(task client ()
  (send echo-server '(:echo self "hello"))
  (let (reply (receive))
    (print reply)))
```

This is a *beautiful* teaching example.

---

## 🌟 3. The “Counter Actor”  
This is the simplest stateful actor example.

### Why it’s perfect
- Demonstrates internal state  
- Demonstrates message‑based mutation  
- Demonstrates request/response  
- Demonstrates actor lifetime  

### t2‑agc version (conceptual)
```t2
(task counter ()
  (let (state 0)
    (loop
      (let (msg (receive))
        (match msg
          ('(:inc n)
            (set! state (+ state n))
            (yield)
            (recur))
          ('(:get from)
            (send from state)
            (yield)
            (recur)))))))
```

This is the “Hello World” of actor systems.

---

## 🌟 4. The “Ring of Processes”  
A classic Erlang concurrency demo.

### Why it’s perfect
- Shows how to spawn many tasks  
- Shows message passing in a ring  
- Shows cooperative scheduling under load  
- Shows how t2‑agc handles many tasks (10–200)  

### t2‑agc version (conceptual)
- Create N tasks  
- Each task forwards a token to the next  
- The last task sends back to the first  

This is a great stress test and teaching tool.

---

## 🌟 5. The “Supervisor + Worker” Pattern  
Erlang’s OTP roots.

### Why it’s perfect
- Demonstrates supervision  
- Demonstrates restartability  
- Demonstrates failure handling  
- Demonstrates exceptional events  
- Demonstrates orchestrator history  

### t2‑agc version (conceptual)
Supervisor:

```t2
(task supervisor ()
  (let (worker (spawn worker))
    (loop
      (let (msg (receive))
        (match msg
          ('(:worker-died)
            (set! worker (spawn worker))
            (yield)
            (recur)))))))
```

Worker:

```t2
(task worker ()
  (if (random-failure?)
      (send supervisor '(:worker-died))
      (yield)))
```

This example shows off t2‑agc’s debugging and exceptional‑event system.

---

## 🌟 6. The “Timer Server”  
A classic Erlang example.

### Why it’s perfect
- Demonstrates capabilities  
- Demonstrates effects  
- Demonstrates timeouts  
- Demonstrates effect‑biased history  

### t2‑agc version (conceptual)
```t2
(task timer-server ()
  (loop
    (let (msg (receive))
      (match msg
        ('(:after ms from)
          (effect timer :sleep ms)
          (send from '(:timeout))
          (yield)
          (recur)))))))
```

This is a great example for teaching effects.

---

## 🌟 7. The “Chat Room” (Mini‑PubSub)  
A slightly larger but still tiny example.

### Why it’s perfect
- Demonstrates broadcast  
- Demonstrates multiple subscribers  
- Demonstrates actor state  
- Demonstrates mailbox fan‑out  

### t2‑agc version (conceptual)
```t2
(task chat-room ()
  (let (subs [])
    (loop
      (let (msg (receive))
        (match msg
          ('(:join pid)
            (push! subs pid)
            (yield)
            (recur))
          ('(:say from text)
            (for-each subs (lambda (s) (send s '(:msg from text))))
            (yield)
            (recur)))))))
```

This is a great “slightly bigger” example.

---

# 🌟 Which ones are the best for teaching?

If I had to pick the **top three** for a tutorial sequence:

### **1. Counter Actor**  
Teaches state + messaging.

### **2. Ping‑Pong**  
Teaches concurrency + scheduling + yield.

### **3. Echo Server**  
Teaches actor loops + request/response.

Then you can graduate to:

- Ring of processes  
- Supervisor/worker  
- Timer server  
- Chat room  

These examples scale beautifully with t2‑agc’s debugging model.
