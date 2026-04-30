import { Link, useLocation } from "react-router-dom";
import { Phone, Users, PhoneCall, FileSpreadsheet, Play } from "lucide-react";

const nav = [
  { path: "/clients", label: "Clients", icon: Users },
  { path: "/calls", label: "Calls", icon: PhoneCall },
  { path: "/campaigns", label: "Campaigns", icon: FileSpreadsheet },
  { path: "/playground", label: "Playground", icon: Play },
];

export default function Layout({ children }) {
  const loc = useLocation();

  return (
    <div style={styles.container}>
      <aside style={styles.sidebar}>
        <div style={styles.logo}>
          <Phone size={24} />
          <span>AI Calling</span>
        </div>
        <nav style={styles.nav}>
          {nav.map(({ path, label, icon: Icon }) => (
            <Link
              key={path}
              to={path}
              style={{
                ...styles.navLink,
                ...(loc.pathname.startsWith(path) ? styles.navLinkActive : {}),
              }}
            >
              <Icon size={18} />
              {label}
            </Link>
          ))}
        </nav>
      </aside>
      <main style={styles.main}>{children}</main>
    </div>
  );
}

const styles = {
  container: { display: "flex", minHeight: "100vh" },
  sidebar: {
    width: 220,
    background: "#0f172a",
    color: "#e2e8f0",
    padding: "1.5rem 0",
  },
  logo: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "0 1.5rem",
    fontSize: "1.1rem",
    fontWeight: 600,
    marginBottom: "1.5rem",
  },
  nav: { display: "flex", flexDirection: "column", gap: 2 },
  navLink: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "0.6rem 1.5rem",
    color: "#94a3b8",
    textDecoration: "none",
    fontSize: "0.95rem",
  },
  navLinkActive: {
    background: "rgba(255,255,255,0.08)",
    color: "#fff",
  },
  main: {
    flex: 1,
    padding: "2rem",
    background: "#f8fafc",
    overflow: "auto",
  },
};
