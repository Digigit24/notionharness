type LogLevel = 'info' | 'warn' | 'error'

interface AuditEvent {
  event?: string
  sessionId?: string
  workspaceId?: string
  containerId?: string
  containerName?: string
  [key: string]: unknown
}

function write(level: LogLevel, message: string, fields: AuditEvent) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  })
  if (typeof process !== 'undefined') {
    if (level === 'error') process.stderr.write(line + '\n')
    else process.stdout.write(line + '\n')
  }
}

export const sandboxLogger = {
  info(message: string, fields: AuditEvent = {}) {
    write('info', message, fields)
  },
  warn(message: string, fields: AuditEvent = {}) {
    write('warn', message, fields)
  },
  error(message: string, fields: AuditEvent = {}) {
    write('error', message, fields)
  },
}
