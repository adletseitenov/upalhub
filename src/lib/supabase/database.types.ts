export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      attempt_items: {
        Row: {
          answer: Json | null
          attempt_id: string
          is_correct: boolean | null
          task_id: string
          time_ms: number | null
        }
        Insert: {
          answer?: Json | null
          attempt_id: string
          is_correct?: boolean | null
          task_id: string
          time_ms?: number | null
        }
        Update: {
          answer?: Json | null
          attempt_id?: string
          is_correct?: boolean | null
          task_id?: string
          time_ms?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "attempt_items_attempt_id_fkey"
            columns: ["attempt_id"]
            isOneToOne: false
            referencedRelation: "attempts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attempt_items_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      attempts: {
        Row: {
          finished_at: string | null
          id: string
          raw_score: number | null
          scaled_score: number | null
          started_at: string
          test_id: string
          user_id: string
        }
        Insert: {
          finished_at?: string | null
          id?: string
          raw_score?: number | null
          scaled_score?: number | null
          started_at?: string
          test_id: string
          user_id: string
        }
        Update: {
          finished_at?: string | null
          id?: string
          raw_score?: number | null
          scaled_score?: number | null
          started_at?: string
          test_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "attempts_test_id_fkey"
            columns: ["test_id"]
            isOneToOne: false
            referencedRelation: "tests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attempts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      exam_profiles: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          language: string
          origin: string
          slug: string
          sources: Json
          spec: Json
          title: string
          trust: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          language: string
          origin: string
          slug: string
          sources?: Json
          spec: Json
          title: string
          trust?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          language?: string
          origin?: string
          slug?: string
          sources?: Json
          spec?: Json
          title?: string
          trust?: string
        }
        Relationships: [
          {
            foreignKeyName: "exam_profiles_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      families: {
        Row: {
          created_at: string
          id: string
          parent_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          parent_id: string
        }
        Update: {
          created_at?: string
          id?: string
          parent_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "families_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      family_members: {
        Row: {
          family_id: string
          student_id: string
        }
        Insert: {
          family_id: string
          student_id: string
        }
        Update: {
          family_id?: string
          student_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "family_members_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "family_members_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      forecasts: {
        Row: {
          confidence: string
          created_at: string
          high: number
          hq_id: string
          id: string
          low: number
        }
        Insert: {
          confidence: string
          created_at?: string
          high: number
          hq_id: string
          id?: string
          low: number
        }
        Update: {
          confidence?: string
          created_at?: string
          high?: number
          hq_id?: string
          id?: string
          low?: number
        }
        Relationships: [
          {
            foreignKeyName: "forecasts_hq_id_fkey"
            columns: ["hq_id"]
            isOneToOne: false
            referencedRelation: "study_hqs"
            referencedColumns: ["id"]
          },
        ]
      }
      hub_stars: {
        Row: {
          hub_id: string
          user_id: string
        }
        Insert: {
          hub_id: string
          user_id: string
        }
        Update: {
          hub_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "hub_stars_hub_id_fkey"
            columns: ["hub_id"]
            isOneToOne: false
            referencedRelation: "hubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hub_stars_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      hubs: {
        Row: {
          created_at: string
          description: string | null
          exam_profile_id: string
          id: string
          origin_hub_id: string | null
          owner_id: string
          stars_count: number
          title: string
          visibility: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          exam_profile_id: string
          id?: string
          origin_hub_id?: string | null
          owner_id: string
          stars_count?: number
          title: string
          visibility?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          exam_profile_id?: string
          id?: string
          origin_hub_id?: string | null
          owner_id?: string
          stars_count?: number
          title?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "hubs_exam_profile_id_fkey"
            columns: ["exam_profile_id"]
            isOneToOne: false
            referencedRelation: "exam_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hubs_origin_hub_id_fkey"
            columns: ["origin_hub_id"]
            isOneToOne: false
            referencedRelation: "hubs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "hubs_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_states: {
        Row: {
          hq_id: string
          level: number
          topic: string
          updated_at: string
        }
        Insert: {
          hq_id: string
          level: number
          topic: string
          updated_at?: string
        }
        Update: {
          hq_id?: string
          level?: number
          topic?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_states_hq_id_fkey"
            columns: ["hq_id"]
            isOneToOne: false
            referencedRelation: "study_hqs"
            referencedColumns: ["id"]
          },
        ]
      }
      parent_reports: {
        Row: {
          body: Json
          family_id: string
          id: string
          sent_at: string | null
          student_id: string
          week_start: string
        }
        Insert: {
          body: Json
          family_id: string
          id?: string
          sent_at?: string | null
          student_id: string
          week_start: string
        }
        Update: {
          body?: Json
          family_id?: string
          id?: string
          sent_at?: string | null
          student_id?: string
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "parent_reports_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parent_reports_student_id_fkey"
            columns: ["student_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          is_author: boolean
          locale: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          is_author?: boolean
          locale?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          is_author?: boolean
          locale?: string
        }
        Relationships: []
      }
      study_hqs: {
        Row: {
          created_at: string
          exam_date: string | null
          exam_profile_id: string
          id: string
          status: string
          target: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          exam_date?: string | null
          exam_profile_id: string
          id?: string
          status?: string
          target?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          exam_date?: string | null
          exam_profile_id?: string
          id?: string
          status?: string
          target?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_hqs_exam_profile_id_fkey"
            columns: ["exam_profile_id"]
            isOneToOne: false
            referencedRelation: "exam_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "study_hqs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      study_plan_weeks: {
        Row: {
          hq_id: string
          id: string
          status: string
          topics: Json
          week_start: string
        }
        Insert: {
          hq_id: string
          id?: string
          status?: string
          topics: Json
          week_start: string
        }
        Update: {
          hq_id?: string
          id?: string
          status?: string
          topics?: Json
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "study_plan_weeks_hq_id_fkey"
            columns: ["hq_id"]
            isOneToOne: false
            referencedRelation: "study_hqs"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          id: string
          owner_id: string
          period_end: string | null
          plan: string
          provider: string | null
          status: string
        }
        Insert: {
          id?: string
          owner_id: string
          period_end?: string | null
          plan: string
          provider?: string | null
          status: string
        }
        Update: {
          id?: string
          owner_id?: string
          period_end?: string | null
          plan?: string
          provider?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          answer: Json
          body: Json
          content_hash: string | null
          created_at: string
          difficulty: number
          exam_profile_id: string
          explanation: string | null
          hub_id: string | null
          id: string
          language: string
          origin: string
          topic: string
          type: string
        }
        Insert: {
          answer: Json
          body: Json
          content_hash?: string | null
          created_at?: string
          difficulty: number
          exam_profile_id: string
          explanation?: string | null
          hub_id?: string | null
          id?: string
          language: string
          origin: string
          topic: string
          type: string
        }
        Update: {
          answer?: Json
          body?: Json
          content_hash?: string | null
          created_at?: string
          difficulty?: number
          exam_profile_id?: string
          explanation?: string | null
          hub_id?: string | null
          id?: string
          language?: string
          origin?: string
          topic?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_exam_profile_id_fkey"
            columns: ["exam_profile_id"]
            isOneToOne: false
            referencedRelation: "exam_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_hub_id_fkey"
            columns: ["hub_id"]
            isOneToOne: false
            referencedRelation: "hubs"
            referencedColumns: ["id"]
          },
        ]
      }
      tests: {
        Row: {
          created_at: string
          hq_id: string
          id: string
          kind: string
          spec: Json
        }
        Insert: {
          created_at?: string
          hq_id: string
          id?: string
          kind: string
          spec: Json
        }
        Update: {
          created_at?: string
          hq_id?: string
          id?: string
          kind?: string
          spec?: Json
        }
        Relationships: [
          {
            foreignKeyName: "tests_hq_id_fkey"
            columns: ["hq_id"]
            isOneToOne: false
            referencedRelation: "study_hqs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
