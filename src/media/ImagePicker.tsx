import { useEffect, useId, useRef, useState } from 'react'

/** Selector de imágenes: botón de archivos, arrastrar y soltar (eventos nativos) y pegar desde el portapapeles. */
export function ImagePicker({ onFiles, multiple = false, disabled = false, label }: { onFiles: (files: File[]) => void; multiple?: boolean; disabled?: boolean; label: string }) {
  const inputId = useId()
  const [over, setOver] = useState(false)
  const cb = useRef(onFiles)
  cb.current = onFiles

  useEffect(() => {
    if (disabled) return
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
      if (files.length > 0) {
        e.preventDefault()
        cb.current(multiple ? files : files.slice(0, 1))
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [disabled, multiple])

  return (
    <div
      onDragOver={(e) => {
        if (disabled) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        if (disabled) return
        const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
        if (files.length) onFiles(multiple ? files : files.slice(0, 1))
      }}
      className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-6 text-center ${over ? 'border-cyan-300 bg-cyan-950/40' : 'border-slate-600'}`}
    >
      <p className="text-slate-200">{label}</p>
      <p className="text-xs text-slate-300">Arrastra la imagen aquí, pégala (Ctrl+V) o elígela:</p>
      <label htmlFor={inputId} className={`cursor-pointer rounded-md border border-slate-500 px-3 py-2 text-sm font-semibold ${disabled ? 'opacity-50' : 'hover:bg-slate-800'}`}>
        Elegir archivo{multiple ? 's' : ''}
      </label>
      <input
        id={inputId}
        type="file"
        accept="image/*"
        multiple={multiple}
        disabled={disabled}
        className="sr-only"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length) onFiles(files)
        }}
      />
    </div>
  )
}
