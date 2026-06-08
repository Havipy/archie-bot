'use client';

export default function LogoutButton() {
  async function handleLogout() {
    await fetch('/api/login', { method: 'DELETE' });
    window.location.href = '/login';
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      className="text-sm text-gray-400 hover:text-gray-600 transition"
    >
      Sign out
    </button>
  );
}
