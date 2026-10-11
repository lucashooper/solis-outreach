import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DiscordConnectorCard } from '../components/DiscordConnectorCard';
import { GmailConnectorCard } from '../components/GmailConnectorCard';
import { useFeedback } from '../components/feedback';

export function Connectors() {
  const { toast } = useFeedback();
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    const gmail = params.get('gmail');
    if (!gmail) return;
    if (gmail === 'connected') toast('success', 'Gmail connected.');
    else toast('error', params.get('reason') || 'Gmail was not connected.');
    const next = new URLSearchParams(params);
    next.delete('gmail');
    next.delete('reason');
    setParams(next, { replace: true });
  }, [params, setParams, toast]);

  return (
    <div className="page">
      <div>
        <h1 className="page-title">Connectors</h1>
      </div>
      <div className="grid w-full gap-4 lg:grid-cols-2">
        <GmailConnectorCard />
        <DiscordConnectorCard />
      </div>
    </div>
  );
}
