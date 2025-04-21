export const generateMeetingLink = (): string => {
    const segments = 3;
    const segmentLength = 3;
    const charset = 'abcdefghijklmnopqrstuvwxyz0123456789';
  
    function generateSegment(): string {
      let segment = '';
      for (let i = 0; i < segmentLength; i++) {
        const randomIndex = Math.floor(Math.random() * charset.length);
        segment += charset[randomIndex];
      }
      return segment;
    }
  
    const link = Array(segments).fill(null).map(() => generateSegment()).join('-');
    return link;
  }