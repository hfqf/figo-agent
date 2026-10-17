import logo from "../../assets/figo-agent-logo.png";
import "./brand-logo.css";

export function BrandLogo({ className = "brand-mark" }: { className?: string }) {
  return <img className={`${className} brand-logo`} src={logo} width={28} height={28} alt="" aria-hidden="true" />;
}
