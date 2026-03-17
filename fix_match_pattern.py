import re

with open('src/match_pattern.t2', 'r') as f:
    content = f.read()

# Fix types in match_pattern.t2
content = content.replace('(== pattern "_")', '(=== pattern "_")')
content = content.replace('(== (typeof pattern) "symbol")', '(=== (typeof pattern) "symbol")')
content = content.replace('(== (typeof pattern) "number")', '(=== (typeof pattern) "number")')
content = content.replace('(== (typeof pattern) "string")', '(=== (typeof pattern) "string")')
content = content.replace('(== pattern value)', '(=== pattern value)')
content = content.replace('(== (. pattern length) (. value length))', '(=== (. pattern length) (. value length))')

with open('src/match_pattern.t2', 'w') as f:
    f.write(content)

with open('tests/match_pattern.test.ts', 'r') as f:
    test_content = f.read()

# Update MATCH_PATTERN_DEF
content_for_literal = content.replace('\\', '\\\\').replace('`', '\\`').replace('$', '\\$')
test_content = re.sub(r'const MATCH_PATTERN_DEF = `[\s\S]*?`;', f'const MATCH_PATTERN_DEF = `{content_for_literal}`;', test_content)

with open('tests/match_pattern.test.ts', 'w') as f:
    f.write(test_content)
