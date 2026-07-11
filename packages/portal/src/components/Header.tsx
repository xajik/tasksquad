import TopNav from './TopNav'

interface HeaderProps {
  source: string
}

export default function Header({ source }: HeaderProps) {
  return (
    <header className="max-w-[800px] mx-auto px-4 sm:px-6 pt-[calc(2.5rem+env(safe-area-inset-top,0px))] sm:pt-16">
      <TopNav source={source} />
    </header>
  )
}
