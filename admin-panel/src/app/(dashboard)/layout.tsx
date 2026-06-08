import LogoutButton from '@/components/LogoutButton';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="border-b border-gray-200 bg-white shadow-sm">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500">
            <span className="text-sm font-bold text-white">A</span>
          </div>
          <a href="/" className="text-lg font-semibold transition hover:text-brand-600">
            Archie Admin
          </a>
          <nav className="flex items-center gap-4 text-sm">
            <a href="/" className="text-gray-500 hover:text-gray-900">
              Namespaces
            </a>
          </nav>
          <div className="flex-1" />
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </>
  );
}
