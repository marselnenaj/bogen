import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/Card';

export function App() {
  return (
    <main className="flex flex-col gap-6 p-10">
      <Card title="Welcome" body="A fixture for code components." highlighted />
      <div className="flex gap-2">
        <Button>Save</Button>
        <Button variant="outline" size="sm">Cancel</Button>
        <Badge tone="success">Live</Badge>
      </div>
    </main>
  );
}
