// R3.8 verification. Two halves that matter equally: secrets must go, and
// ordinary text must survive untouched — an over-eager redactor that eats
// real error messages is its own bug.
import { redactSecrets } from '../lib/redact'

const MUST_REDACT: Array<[string, string]> = [
  ['Authorization: Bearer abcdef1234567890abcdef', 'bearer token in a header'],
  ['git clone https://ritik:ghp_aaaaaaaaaaaaaaaaaaaa@github.com/x/y.git', 'credentials in a URL'],
  ['{"api_key": "sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA"}', 'json api_key'],
  ['OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx', 'env assignment'],
  ['token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'a JWT'],
  ['xoxb-1234567890-abcdefghijk', 'a slack token'],
  ['AKIAIOSFODNN7EXAMPLE', 'an AWS access key id'],
  ['password=hunter2isnotlongenoughbutthisis', 'a password assignment'],
]

const MUST_SURVIVE: string[] = [
  'HTTP 429: The usage limit has been reached',
  'ENOENT: no such file or directory, open /home/ritik/project/src/index.ts',
  'The model gpt-5.4-mini is not available for this account.',
  'Token limit exceeded: 272000 tokens',
  'error: pathspec main did not match any file(s) known to git',
  'connect ECONNREFUSED 127.0.0.1:5432',
]

let failures = 0

console.log('--- must be redacted ---')
for (const [input, label] of MUST_REDACT) {
  const out = redactSecrets(input)
  const clean = out.includes('[redacted]') && out !== input
  if (!clean) failures += 1
  console.log(`${clean ? 'PASS' : 'FAIL'}  ${label}`)
  if (!clean) console.log(`      got: ${out}`)
}

console.log('')
console.log('--- must survive unchanged ---')
for (const input of MUST_SURVIVE) {
  const out = redactSecrets(input)
  const same = out === input
  if (!same) failures += 1
  console.log(`${same ? 'PASS' : 'FAIL'}  ${input.slice(0, 60)}`)
  if (!same) console.log(`      got: ${out}`)
}

console.log('')
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
