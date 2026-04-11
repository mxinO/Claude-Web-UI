interface Props { command: string; output: string; }

export function BashOutput({ command, output }: Props) {
  return (
    <div className="bash-output">
      <div style={{ color: 'var(--green)', marginBottom: 8 }}>$ {command}</div>
      <div>{output}</div>
    </div>
  );
}
