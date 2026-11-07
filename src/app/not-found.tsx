import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl py-8">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-neutral-600">The page you are looking for does not exist.</p>
      <Link href="/" className="mt-4 inline-block text-sm underline">
        Back to home
      </Link>
    </div>
  );
}
