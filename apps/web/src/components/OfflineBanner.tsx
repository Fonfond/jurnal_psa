import { useOnline } from '../hooks/useOnline';

export function OfflineBanner(): JSX.Element | null {
  const online = useOnline();
  if (online) {
    return null;
  }
  return (
    <div className="offline-banner" role="status">
      Нет сети. Новые записи сохраняются на устройстве и уйдут при подключении.
    </div>
  );
}
