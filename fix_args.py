import sys

with open("tests/examples.test.t2", "r") as f:
    text = f.read()

text = text.replace(
"""      (let (client_fn) (generator-fn ((args))
        (let (server_pid) (index args 0))
        (let (my_id) (index args 1))""",
"""      (let (client_fn) (generator-fn ((server_pid) (my_id))"""
)

text = text.replace(
"""      (let (client_fn) (generator-fn ((args))
        (let (server_pid) (index args 0))""",
"""      (let (client_fn) (generator-fn ((server_pid))"""
)

with open("tests/examples.test.t2", "w") as f:
    f.write(text)
