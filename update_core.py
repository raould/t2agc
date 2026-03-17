import re

with open('src/scheduler.t2', 'r') as f:
    scheduler_core = f.read()

scheduler_core = scheduler_core.replace('\\', '\\\\').replace('`', '\\`').replace('$', '\\$')

# Now update tests/scheduler.test.ts
with open('tests/scheduler.test.ts', 'r') as f:
    test_content = f.read()

# find const SCHEDULER_CORE = `...`; and replace the inside
test_content = re.sub(r'const SCHEDULER_CORE = `[\s\S]*?`;', f'const SCHEDULER_CORE = `{scheduler_core}`;', test_content)

with open('tests/scheduler.test.ts', 'w') as f:
    f.write(test_content)


# Now update tests/runtime.test.ts
with open('tests/runtime.test.ts', 'r') as f:
    test_content = f.read()

# find const SCHEDULER_DEF = `...`; and replace the inside
test_content = re.sub(r'const SCHEDULER_DEF = `[\s\S]*?`;', f'const SCHEDULER_DEF = `{scheduler_core}`;', test_content)

with open('tests/runtime.test.ts', 'w') as f:
    f.write(test_content)

