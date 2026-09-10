interface InfoModalProps {
  onClose: () => void;
}

export function InfoModal({ onClose }: InfoModalProps) {
  return (
    <div className="fixed inset-0 z-999 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card text-card-foreground w-96 rounded-md border p-6">
        <div className="space-y-3 text-sm leading-relaxed">
          <p>
            Every parcel in the Municipality of Anchorage. The data is scraped
            daily from the <a href="https://property.muni.org/">muni&apos;s property database</a>;
          </p>
          <p>
            If this app doesn't give you the info in a format that is useful to you,
            then ask your favorite AI agent (claude, chatGPT) to
            "<code>Using github.com/NickCrews/anchorage-property, [your question here]</code>"
            and it should be able to pull the data itself and answer your question.
          </p>
          <p>
            See <a href="https://github.com/NickCrews/anchorage-property">https://github.com/NickCrews/anchorage-property</a> for the source code and more information about the data.
          </p>
        </div>
        <button
          onClick={onClose}
          className="mt-5 w-full rounded bg-[#e67f5f] py-2 text-sm text-white"
        >
          Close
        </button>
      </div>
    </div>
  );
}
