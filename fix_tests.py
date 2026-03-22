import sys

with open("tests/examples.test.t2", "r") as f:
    text = f.read()

text = text.replace(
    """(concat "hello from " my_id)""",
    """(+ "hello from " my_id)"""
)

with open("tests/examples.test.t2", "w") as f:
    f.write(text)
