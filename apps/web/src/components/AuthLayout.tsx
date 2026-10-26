import type { ReactNode } from 'react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';

/** Centered card used by the sign-in and registration screens. */
export function AuthLayout(props: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between px-4 py-3">
        <span className="flex items-center gap-2 font-semibold">
          <img src="/favicon.svg" alt="" className="size-6" />
          Opportun
        </span>
        <ThemeToggle />
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-4 pt-[10vh] pb-12">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <h1 className="text-xl leading-tight font-semibold">{props.title}</h1>
            <CardDescription>{props.description}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {props.children}
            {props.footer === undefined ? null : (
              <p className="text-center text-sm text-muted-foreground">{props.footer}</p>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
