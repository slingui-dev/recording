import React, { useState, useEffect } from "react";
import * as Tabs from "@radix-ui/react-tabs";

import VideoItem from "../components/VideoItem";

import {
  TempTwitter,
  TempDesignSystem,
  TempFigma,
  TempSubstack,
  TempMarketing,
  DropdownIcon,
} from "../../images/popup/images";

const VideosTab = () => {
  const [URL, SetURL] = useState("https://tally.so/r/npojNV");
  const [shortcut, setShortcut] = useState("Ctrl+D");

  useEffect(() => {
    const locale = chrome.i18n.getMessage("@@ui_locale");
    if (!locale.includes("en")) {
      SetURL(
        `https://translate.google.com/translate?sl=en&tl=${locale}&u=https://tally.so/r/npojNV`
      );
    }

    if (window.navigator.platform.toUpperCase().indexOf("MAC") >= 0) {
      setShortcut("⌘+D");
    }
  }, []);

  // Example temporary data
  const videos = [
    { name: "Bug report", thumbnail: TempTwitter, date: "3 minutes ago" },
    { name: "Figma async review", thumbnail: TempFigma, date: "1 hour ago" },
    {
      name: "Design systems onboarding",
      thumbnail: TempDesignSystem,
      date: "4 days ago",
    },
    { name: "Cool SaaS resources", thumbnail: TempMarketing, date: "Feb 12" },
    { name: "Newsletter promo", thumbnail: TempSubstack, date: "Jan 23" },
  ];

  return (
    <div className="video-ui">
      <Tabs.Root className="TabsRoot" defaultValue="personal">
        <Tabs.List className="TabsList" aria-label="Manage your account">
          <div className="TabsTriggerWrap">
            <Tabs.Trigger className="TabsTrigger" value="personal">
              <div className="TabsTriggerLabel">
                <span>Personal</span>
              </div>
            </Tabs.Trigger>
          </div>
          <div className="TabsSort" tabIndex="0">
            <div className="TabsSortLabel">
              Latest <img src={DropdownIcon} />
            </div>
          </div>
        </Tabs.List>
        <Tabs.Content className="TabsContent" value="personal">
          <div className="videos-list">
            {videos.map((video, i) => (
              <VideoItem
                title={video.name}
                key={i}
                date={video.date}
                thumbnail={video.thumbnail}
              />
            ))}
          </div>
          <div className="bottom-section">
            <button
              role="button"
              className="main-button dashboard-button"
              tabIndex="0"
            >
              <span className="main-button-label">Go to dashboard</span>
              <span className="main-button-shortcut">{shortcut}</span>
            </button>
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
};

export default VideosTab;
