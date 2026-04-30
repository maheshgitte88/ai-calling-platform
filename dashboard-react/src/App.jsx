import { BrowserRouter, Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import Clients from "./pages/Clients";
import ClientConfig from "./pages/ClientConfig";
import Calls from "./pages/Calls";
import Campaigns from "./pages/Campaigns";
import Playground from "./pages/Playground";

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Clients />} />
          <Route path="/clients" element={<Clients />} />
          <Route path="/clients/:clientId/config" element={<ClientConfig />} />
          <Route path="/calls" element={<Calls />} />
          <Route path="/campaigns" element={<Campaigns />} />
          <Route path="/playground" element={<Playground />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
