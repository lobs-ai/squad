import type { CSSProperties, ReactNode } from "react";

interface CardProps {
  title?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
  accent?: boolean;
}

export function Card({ title, badge, actions, children, style, bodyStyle, accent }: CardProps): JSX.Element {
  return (
    <div
      className="card"
      style={{
        display: "flex",
        flexDirection: "column",
        ...(accent ? { boxShadow: "inset 2px 0 0 var(--accent)" } : null),
        ...style,
      }}
    >
      {title && (
        <div className="card-head">
          <span className="title">{title}</span>
          {badge}
          <div className="actions">{actions}</div>
        </div>
      )}
      <div className="card-body" style={{ flex: 1, minHeight: 0, ...bodyStyle }}>
        {children}
      </div>
    </div>
  );
}

interface PageHeadProps {
  title: ReactNode;
  crumbs?: ReactNode;
  actions?: ReactNode;
}

export function PageHead({ title, crumbs, actions }: PageHeadProps): JSX.Element {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {crumbs && <span className="crumbs">/ {crumbs}</span>}
      <span className="spacer" />
      {actions}
    </div>
  );
}
