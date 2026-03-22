import sys

with open("tests/examples.test.t2", "r") as f:
    text = f.read()

text = text.replace(
"""          (if (=== (index msg 0) "echo")""",
"""          (console.log "Server received: " msg)
          (if (=== (index msg 0) "echo")"""
)

text = text.replace(
"""        (let (reply) (yield (object (type "receive") (patterns null))))
        (if (=== (index reply 1) (+ "hello from " my_id))""",
"""        (let (reply) (yield (object (type "receive") (patterns null))))
        (console.log "Client received: " reply " (expected: " (+ "hello from " my_id) ")")
        (if (=== (index reply 1) (+ "hello from " my_id))"""
)

with open("tests/examples.test.t2", "w") as f:
    f.write(text)
