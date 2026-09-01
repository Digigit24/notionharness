import Link from 'next/link'

export const metadata = {
  title: 'Dev Demo Routes | NotionForge',
}

interface DemoRoute {
  path: string
  title: string
  description: string
}

const demoRoutes: DemoRoute[] = [
  {
    path: '/chat-ui-demo',
    title: 'Chat UI Demo',
    description: 'Thread component with mock RunEvent data. Demonstrates basic chat UI rendering.',
  },
  {
    path: '/thread-full-page',
    title: 'Thread Full Page',
    description: 'Dedicated full-page view with session list rail. For detailed run examination.',
  },
  {
    path: '/thread-lane-demo',
    title: 'Thread Lane Demo',
    description: 'Grid layout showing multiple threads as lanes. Demonstrates side-by-side monitoring.',
  },
  {
    path: '/tool-catalogue-demo',
    title: 'Tool Catalogue Demo',
    description: 'Tool UI components and renderers catalogue. Internal component gallery.',
  },
  {
    path: '/ui-foundation-demo',
    title: 'UI Foundation Demo',
    description: 'Shadcn and radix-ui component examples. Design system reference.',
  },
]

export default function DevPage() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 py-12 px-4">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Demo Routes</h1>
          <p className="text-gray-600 dark:text-gray-400">
            Internal development and demo pages. Not for production use.
          </p>
        </div>

        <div className="grid gap-4">
          {demoRoutes.map((route) => (
            <Link
              key={route.path}
              href={route.path}
              className="block p-6 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-blue-500 dark:hover:border-blue-500 transition-colors"
            >
              <h2 className="text-lg font-semibold mb-2 text-blue-600 dark:text-blue-400">
                {route.title}
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">{route.description}</p>
              <code className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded text-gray-700 dark:text-gray-300">
                {route.path}
              </code>
            </Link>
          ))}
        </div>

        <div className="mt-12 p-6 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
          <h3 className="font-semibold text-yellow-900 dark:text-yellow-200 mb-2">⚠️ Development Only</h3>
          <p className="text-sm text-yellow-800 dark:text-yellow-300">
            These routes are for development and testing purposes. They may change or be removed without notice.
            Do not link to them from production code or user-facing interfaces.
          </p>
        </div>
      </div>
    </div>
  )
}
